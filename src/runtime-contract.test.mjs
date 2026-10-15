/**
 * Exercise the real extension loader -> native provider -> ModelRuntime -> wire
 * boundary. Run against a different installed host with PI_TEST_CODING_AGENT_ENTRY
 * pointing to that pi-coding-agent's dist/index.js (see CONTRIBUTING.md).
 * No catalog refresh, real credentials, or network requests are needed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const agentEntry = process.env.PI_TEST_CODING_AGENT_ENTRY
  ? pathToFileURL(resolve(process.env.PI_TEST_CODING_AGENT_ENTRY)).href
  : import.meta.resolve("@earendil-works/pi-coding-agent");
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsHostSdk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);
const extensionPath = fileURLToPath(new URL("./index.ts", import.meta.url));
const systemPrompt = "Synthetic system instruction: use the advise tool for blockers.";
const context = {
  systemPrompt,
  messages: [{ role: "user", content: "Review this synthetic plan.", timestamp: 0 }],
  tools: [{
    name: "advise",
    description: "Report a blocker.",
    parameters: { type: "object", properties: { note: { type: "string" } }, required: ["note"] },
  }],
};

test("loaded providers retain system instructions and tools through ModelRuntime", {
  skip: !supportsHostSdk && "Pi's host SDK requires Node >=22.19.0; pure unit tests still run on Node 20",
}, async (t) => {
  const { loadExtensions } = await import(new URL("./core/extensions/loader.js", agentEntry));
  const { ModelRuntime } = await import(new URL("./core/model-runtime.js", agentEntry));
  const agentDir = mkdtempSync(join(tmpdir(), "command-code-contract-"));
  t.after(() => rmSync(agentDir, { recursive: true, force: true }));
  const originalEnv = { ...process.env };
  t.after(() => {
    for (const key of ["PI_CODING_AGENT_DIR", "COMMAND_CODE_API_KEY"]) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.COMMAND_CODE_API_KEY = "synthetic-not-a-real-key";

  const loaded = await loadExtensions([extensionPath], agentDir);
  assert.deepEqual(loaded.errors, []);
  const providers = loaded.runtime.pendingNativeProviderRegistrations.map(({ provider }) => provider);
  assert.deepEqual(providers.map(({ id }) => id), ["command-code", "command-code-anthropic"]);
  const runtime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(agentDir, "auth.json"),
    refreshOnCreate: false,
  });
  for (const provider of providers) runtime.registerNativeProvider(provider);

  for (const provider of providers) {
    for (const method of ["complete", "completeSimple"]) {
      await t.test(`${provider.id} ${method}`, async (t) => {
        const model = {
          id: provider.api === "openai-completions" ? "synthetic-model" : "claude-sonnet-4-5",
          name: "Synthetic model",
          provider: provider.id,
          api: provider.api,
          baseUrl: provider.baseUrl,
          reasoning: false,
          input: ["text"],
          contextWindow: 200000,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        };
        let payload;
        let networkCalls = 0;
        const forbidNetwork = async () => { networkCalls++; throw new Error("NETWORK_FORBIDDEN"); };
        t.mock.method(globalThis, "fetch", forbidNetwork);
        const response = await runtime[method](model, context, {
          apiKey: "synthetic-not-a-real-key",
          fetch: forbidNetwork,
          onPayload: (value) => { payload = value; throw new Error("EXPECTED_CAPTURE_STOP"); },
        });
        assert.equal(networkCalls, 0);
        assert.equal(response.stopReason, "error");
        assert.match(response.errorMessage, /EXPECTED_CAPTURE_STOP/);
        assert.ok(payload, "wire payload must be captured before any network request");
        if (provider.api === "openai-completions") {
          assert.ok(payload.messages.some((message) =>
            ["system", "developer"].includes(message.role) && message.content === systemPrompt),
          "system instruction must survive ModelRuntime normalization");
          assert.deepEqual(payload.tools?.map((tool) => tool.function.name), ["advise"]);
          assert.deepEqual(payload.tools[0].function.parameters, context.tools[0].parameters);
        } else {
          assert.ok(payload.system?.some((block) => block.text === systemPrompt),
            "system instruction must survive ModelRuntime normalization");
          assert.deepEqual(payload.tools?.map((tool) => tool.name), ["advise"]);
          assert.deepEqual(payload.tools[0].input_schema, context.tools[0].parameters);
        }
        assert.ok(payload.messages.some((message) => message.role === "user"));
      });
    }
  }
});
