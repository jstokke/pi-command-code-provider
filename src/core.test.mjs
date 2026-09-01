/**
 * Unit tests for the Command Code extension's core logic.
 * Run: node --test
 * All HTTP is mocked; the live API is never contacted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ANTHROPIC_BASE_URL,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DISCOVERY_TIMEOUT_MS,
  OPENAI_BASE_URL,
  DiscoveryError,
  classifyWire,
  defaultAuthPath,
  defaultOverridesPath,
  fetchCatalog,
  DEFAULT_MAX_TOKENS_REASONING,
  getDefaultMaxTokens,
  inferClaudeThinking,
  loadModelOverrides,
  parseCatalog,
  readStoredApiKey,
  resolveApiKey,
  splitByWire,
  toPiModel,
  toPiModels,
} from "./core.mjs";

const SECRET = "cc-sk-test-0123456789abcdef";

function okFetch(body) {
  return async () => ({ ok: true, status: 200, json: async () => body });
}

function representativeCatalog() {
  return {
    object: "list",
    data: [
      { id: "claude-sonnet-5", object: "model", created: 1, owned_by: "command-code", name: "Claude Sonnet 5", context_length: 1000000 },
      { id: "claude-haiku-4-5-20251001", object: "model", created: 1, owned_by: "command-code", name: "Claude Haiku 4.5", context_length: 200000 },
      { id: "gpt-5.5", object: "model", created: 1, owned_by: "command-code", name: "GPT-5.5", context_length: 400000 },
      { id: "deepseek/deepseek-v4-pro", object: "model", created: 1, owned_by: "command-code", name: "DeepSeek V4 Pro", context_length: 1000000 },
      { id: "z-ai/glm-5.3-flash", object: "model", created: 1, owned_by: "command-code", name: "GLM-5.3 Flash", context_length: 1048576 },
      { id: "deepseek/deepseek-v4-flash-vision-exp", object: "model", created: 1, owned_by: "command-code", name: "DeepSeek V4 Flash Vision (exp)", context_length: 1000000 },
    ],
  };
}

// ---------- /models response parsing ----------

test("parses a representative /models response", () => {
  const models = parseCatalog(representativeCatalog());
  assert.equal(models.length, 6);
  const gpt = models.find((m) => m.id === "gpt-5.5");
  assert.equal(gpt.name, "GPT-5.5");
  assert.equal(gpt.contextLength, 400000);
  assert.equal(gpt.ownedBy, "command-code");
});

test("exact model IDs are preserved verbatim", () => {
  const pi = toPiModels(parseCatalog(representativeCatalog()));
  const ids = pi.map((m) => m.id);
  assert.deepEqual(ids, [
    "claude-sonnet-5",
    "claude-haiku-4-5-20251001",
    "gpt-5.5",
    "deepseek/deepseek-v4-pro",
    "z-ai/glm-5.3-flash",
    "deepseek/deepseek-v4-flash-vision-exp",
  ]);
});

test("missing optional metadata does not crash and falls back to defaults", () => {
  const models = parseCatalog({ data: [{ id: "mystery-model" }] });
  const pi = toPiModel(models[0]);
  assert.equal(pi.id, "mystery-model");
  assert.equal(pi.name, "mystery-model");
  assert.equal(pi.contextWindow, DEFAULT_CONTEXT_WINDOW);
  assert.equal(pi.maxTokens, DEFAULT_MAX_TOKENS);
  assert.deepEqual(pi.input, ["text"]);
  assert.equal(pi.reasoning, false);
  assert.deepEqual(pi.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("vision is enabled only where the catalog names it", () => {
  const pi = toPiModels(parseCatalog(representativeCatalog()));
  const vision = pi.find((m) => m.id === "deepseek/deepseek-v4-flash-vision-exp");
  const text = pi.find((m) => m.id === "gpt-5.5");
  assert.deepEqual(vision.input, ["text", "image"]);
  assert.deepEqual(text.input, ["text"]);
});

test("malformed responses produce useful errors", () => {
  assert.throws(() => parseCatalog(null), DiscoveryError);
  assert.throws(() => parseCatalog([1, 2, 3]), DiscoveryError);
  assert.throws(() => parseCatalog({ object: "list" }), /missing a 'data' array/);
  assert.throws(() => parseCatalog({ data: "nope" }), DiscoveryError);
  assert.throws(() => parseCatalog({ data: [{ nope: true }] }), /data\[0\] has no model id/);
  assert.throws(() => parseCatalog({ data: [null] }), /data\[0\] is not an object/);
  assert.throws(() => parseCatalog({ data: [] }), /catalog is empty/);
  assert.throws(() => parseCatalog({ data: [{ id: "a" }, { id: "" }] }), /data\[1\]/);
});

// ---------- protocol classification ----------

test("anthropic models route to the anthropic provider", () => {
  const models = parseCatalog(representativeCatalog());
  const { anthropicModels } = splitByWire(models);
  assert.deepEqual(
    anthropicModels.map((m) => m.id).sort(),
    ["claude-haiku-4-5-20251001", "claude-sonnet-5"]
  );
});

test("non-anthropic supported models route to the openai provider", () => {
  const models = parseCatalog(representativeCatalog());
  const { openaiModels } = splitByWire(models);
  assert.ok(openaiModels.some((m) => m.id === "gpt-5.5"));
  assert.ok(openaiModels.some((m) => m.id === "deepseek/deepseek-v4-pro"));
  assert.ok(openaiModels.some((m) => m.id === "z-ai/glm-5.3-flash"));
  assert.ok(openaiModels.every((m) => !m.id.startsWith("claude")));
});

test("classifier honors explicit api_type before anything else", () => {
  assert.equal(classifyWire({ id: "something-else", apiType: "anthropic-messages" }), "anthropic");
  assert.equal(classifyWire({ id: "claude-99", apiType: "openai" }), "openai");
});

test("classifier falls back to ownership metadata, then claude id match, then openai", () => {
  assert.equal(classifyWire({ id: "whatever", ownedBy: "anthropic" }), "anthropic");
  assert.equal(classifyWire({ id: "claude-sonnet-5" }), "anthropic");
  assert.equal(classifyWire({ id: "vendor/claude-x" }), "anthropic");
  assert.equal(classifyWire({ id: "gpt-5.5", ownedBy: "command-code" }), "openai");
  assert.equal(classifyWire({ id: "deepseek/deepseek-v4-pro" }), "openai");
});

// ---------- auth resolution ----------

test("env var wins over stored credential", () => {
  const key = resolveApiKey({ env: { COMMAND_CODE_API_KEY: "env-key" }, authPath: "/nonexistent/auth.json" });
  assert.equal(key, "env-key");
});

test("stored auth.json credential is used when env var is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ "command-code": { type: "api_key", key: "stored-key" } }));
  const key = resolveApiKey({ env: {}, authPath: path });
  assert.equal(key, "stored-key");
});

test("missing key resolves to undefined without throwing", () => {
  const key = resolveApiKey({ env: {}, authPath: "/nonexistent/auth.json" });
  assert.equal(key, undefined);
  assert.equal(defaultAuthPath({ env: { PI_CODING_AGENT_DIR: "/custom/dir" } }), join("/custom/dir", "auth.json"));
});

test("non-api_key or malformed stored credentials are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-auth-"));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify({ "command-code": { type: "oauth", access: "x" } }));
  assert.equal(readStoredApiKey("command-code", path), undefined);
  writeFileSync(path, "not json{");
  assert.equal(readStoredApiKey("command-code", path), undefined);
  assert.equal(readStoredApiKey("command-code", "/nonexistent/auth.json"), undefined);
});

// ---------- fetchCatalog behavior ----------

test("fetchCatalog hits the right URL with bearer auth and parses the body", async () => {
  let seen;
  const body = await fetchCatalog({
    apiKey: SECRET,
    fetchImpl: async (url, init) => {
      seen = { url, auth: init.headers.Authorization };
      return { ok: true, status: 200, json: async () => representativeCatalog() };
    },
  });
  assert.equal(seen.url, `${OPENAI_BASE_URL}/models`);
  assert.equal(seen.auth, `Bearer ${SECRET}`);
  assert.equal(body.length, 6);
});

test("401 produces an auth-specific error", async () => {
  await assert.rejects(
    fetchCatalog({ apiKey: SECRET, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }),
    (err) => err instanceof DiscoveryError && /authentication failed \(HTTP 401\)/.test(err.message)
  );
  await assert.rejects(
    fetchCatalog({ apiKey: SECRET, fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) }),
    /authentication failed \(HTTP 403\)/
  );
});

test("missing API key fails fast with an actionable diagnostic, not a crash", async () => {
  let called = 0;
  await assert.rejects(
    fetchCatalog({ apiKey: undefined, fetchImpl: async () => { called++; } }),
    (err) => err instanceof DiscoveryError && /COMMAND_CODE_API_KEY is not set/.test(err.message)
  );
  assert.equal(called, 0, "no request should be made without a key");
});

test("timeout remains bounded and reports a timeout reason", async () => {
  const start = Date.now();
  await assert.rejects(
    fetchCatalog({
      apiKey: SECRET,
      timeoutMs: 100,
      fetchImpl: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    }),
    (err) => err instanceof DiscoveryError && /timed out after 100ms/.test(err.message)
  );
  const elapsed = Date.now() - start;
  assert.ok(elapsed < DISCOVERY_TIMEOUT_MS, `should abort early, took ${elapsed}ms`);
});

test("network errors remain bounded and are reported concisely", async () => {
  await assert.rejects(
    fetchCatalog({ apiKey: SECRET, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }),
    (err) => err instanceof DiscoveryError && /ECONNREFUSED/.test(err.message)
  );
});

test("non-JSON body produces a useful error", async () => {
  await assert.rejects(
    fetchCatalog({ apiKey: SECRET, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new Error("Unexpected token"); } }) }),
    /not valid JSON/
  );
});

test("HTTP 500 produces a generic discovery error", async () => {
  await assert.rejects(
    fetchCatalog({ apiKey: SECRET, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }),
    (err) => err instanceof DiscoveryError && /HTTP 500/.test(err.message)
  );
});

// ---------- secret hygiene ----------

test("no API key appears in any error message", async () => {
  const cases = [
    () => fetchCatalog({ apiKey: undefined }),
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) }),
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => { throw new Error("boom"); } }),
    () => fetchCatalog({ apiKey: SECRET, timeoutMs: 50, fetchImpl: (_u, i) => new Promise((_r, rej) => i.signal.addEventListener("abort", () => rej(new Error("aborted")))) }),
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) }),
    () => fetchCatalog({ apiKey: SECRET, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 42 }] }) }) }),
    () => Promise.reject(parseAndCatch),
  ];
  const parseAndCatch = (async () => {
    try { parseCatalog({ data: [{ id: null }] }); } catch (e) { return e; }
  })();
  for (const [i, run] of cases.entries()) {
    let err;
    try {
      await run();
    } catch (e) {
      err = e;
    }
    const message = err instanceof Error ? err.message : String(await err);
    assert.ok(!message.includes(SECRET), `case ${i} leaked the key: ${message}`);
  }
});

// ---------- maxTokens override plumbing ----------

test("getDefaultMaxTokens falls back to the constant when env is unset", () => {
  assert.equal(getDefaultMaxTokens({ env: {} }), DEFAULT_MAX_TOKENS);
});

test("getDefaultMaxTokens honors a positive integer env var", () => {
  assert.equal(getDefaultMaxTokens({ env: { COMMAND_CODE_DEFAULT_MAX_TOKENS: "65536" } }), 65536);
});

test("getDefaultMaxTokens rejects zero, negative, non-integer, and non-numeric env values", () => {
  for (const bad of ["0", "-1", "12.5", "abc", "1e3", "", "  "]) {
    assert.equal(
      getDefaultMaxTokens({ env: { COMMAND_CODE_DEFAULT_MAX_TOKENS: bad } }),
      DEFAULT_MAX_TOKENS,
      "should fall back for: " + JSON.stringify(bad)
    );
  }
});

test("loadModelOverrides returns an empty Map when the file is missing", () => {
  const overrides = loadModelOverrides({
    path: "/nonexistent/path/command-code-model-overrides.json",
    fsImpl: { readFileSync: () => { throw new Error("ENOENT"); } },
  });
  assert.ok(overrides instanceof Map);
  assert.equal(overrides.size, 0);
});

test("loadModelOverrides parses id keys and mirrors them under the normalized name", () => {
  const overrides = loadModelOverrides({
    path: "anything",
    fsImpl: { readFileSync: () => JSON.stringify({
      "deepseek/deepseek-v4-flash-latest": { maxTokens: 65536 },
    }) },
  });
  assert.equal(overrides.size, 2);
  assert.deepEqual(overrides.get("deepseek/deepseek-v4-flash-latest"), { maxTokens: 65536, contextWindow: undefined });
  assert.deepEqual(overrides.get("deepseekdeepseekv4flashlatest"), { maxTokens: 65536, contextWindow: undefined });
});

test("loadModelOverrides silently drops entries with no usable numeric fields", () => {
  const warnings = [];
  const origError = console.error;
  console.error = (msg) => warnings.push(msg);
  try {
    const overrides = loadModelOverrides({
      path: "anything",
      fsImpl: { readFileSync: () => JSON.stringify({
        "good model": { maxTokens: 1024 },
        badString: { maxTokens: "lots" },
        badFloat: { maxTokens: 1.5 },
        badZero: { maxTokens: 0 },
        badNeg: { maxTokens: -100 },
        empty: {},
        nonObject: "not-an-object",
      }) },
    });
    // "good model" survives as both its exact key and its normalized form
    // ("goodmodel"), so 2 entries. Every other entry is dropped silently.
    assert.equal(overrides.size, 2);
    assert.ok(overrides.has("good model"));
    assert.ok(overrides.has("goodmodel"));
    // No diagnostic is emitted for bad entries — only the file-level diagnostics
    // (malformed JSON / wrong top-level shape) print.
    assert.equal(warnings.length, 0);
  } finally {
    console.error = origError;
  }
});

test("loadModelOverrides emits a diagnostic on malformed JSON and returns an empty Map", () => {
  const warnings = [];
  const origError = console.error;
  console.error = (msg) => warnings.push(msg);
  try {
    const overrides = loadModelOverrides({
      path: "/some/file.json",
      fsImpl: { readFileSync: () => "not json{" },
    });
    assert.equal(overrides.size, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /not valid JSON/);
    assert.match(warnings[0], /\/some\/file\.json/);
  } finally {
    console.error = origError;
  }
});

test("loadModelOverrides emits a diagnostic on wrong top-level shape", () => {
  const warnings = [];
  const origError = console.error;
  console.error = (msg) => warnings.push(msg);
  try {
    const overrides = loadModelOverrides({
      path: "x",
      fsImpl: { readFileSync: () => JSON.stringify([1, 2, 3]) },
    });
    assert.equal(overrides.size, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /JSON object at the top level/);
  } finally {
    console.error = origError;
  }
});

test("defaultOverridesPath honors PI_CODING_AGENT_DIR", () => {
  assert.equal(
    defaultOverridesPath({ env: { PI_CODING_AGENT_DIR: "/custom" } }),
    join("/custom", "command-code-model-overrides.json")
  );
});

test("toPiModel with no override falls back to getDefaultMaxTokens()", () => {
  // Pin the default so this test does not depend on the process env.
  const pi = toPiModel({ id: "mystery" }, undefined, 4242);
  assert.equal(pi.maxTokens, 4242);
});

test("toPiModel stamps provider-scoped metadata when meta is given", () => {
  const pi = toPiModel(
    { id: "gpt-5.5", name: "GPT-5.5" },
    undefined,
    undefined,
    { provider: "command-code", api: "openai-completions", baseUrl: "https://api.commandcode.ai/provider/v1" }
  );
  // Pi's model runtime drops models without `provider` from /model and
  // dispatches requests by `api`; baseUrl anchors the request URL.
  assert.equal(pi.provider, "command-code");
  assert.equal(pi.api, "openai-completions");
  assert.equal(pi.baseUrl, "https://api.commandcode.ai/provider/v1");
  // Omitting meta (tests, legacy callers) must not add empty fields.
  const bare = toPiModel({ id: "mystery" });
  assert.equal(bare.provider, undefined);
  assert.equal(bare.api, undefined);
});

test("toPiModel override raises maxTokens when /models does not publish it", () => {
  const overrides = new Map([["mystery", { maxTokens: 65536 }]]);
  const pi = toPiModel({ id: "mystery" }, overrides);
  assert.equal(pi.maxTokens, 65536);
});

test("toPiModel override raises maxTokens above the /models cap", () => {
  const overrides = new Map([["deepseek/deepseek-v4-flash-latest", { maxTokens: 32768 }]]);
  const pi = toPiModel({ id: "deepseek/deepseek-v4-flash-latest", maxTokens: 4096 }, overrides);
  assert.equal(pi.maxTokens, 32768);
});

test("toPiModel override cannot lower maxTokens below the /models cap", () => {
  // Command Code's authoritative cap wins; an override can only raise.
  const overrides = new Map([["claude-opus", { maxTokens: 4096 }]]);
  const pi = toPiModel({ id: "claude-opus", maxTokens: 16384 }, overrides);
  assert.equal(pi.maxTokens, 16384);
});

test("toPiModel override matches by id first, then by normalized display name", () => {
  const overrides = new Map([
    ["claudehaiku45", { maxTokens: 11111 }],
    ["claude-haiku-4-5-20251001", { maxTokens: 99999 }],
  ]);
  // Id hit wins.
  const byId = toPiModel({ id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" }, overrides);
  assert.equal(byId.maxTokens, 99999);
  // Falls back to normalized-name hit when id miss.
  const byName = toPiModel({ id: "x", name: "Claude Haiku 4.5" }, overrides);
  assert.equal(byName.maxTokens, 11111);
});

test("toPiModel override raises contextWindow when /models reports a smaller value", () => {
  const overrides = new Map([["a", { contextWindow: 500000 }]]);
  const pi = toPiModel({ id: "a", contextLength: 200000 }, overrides);
  assert.equal(pi.contextWindow, 500000);
});

test("toPiModel override with missing fields falls back to defaults", () => {
  const pi = toPiModel({ id: "a" }, new Map([["a", {}]]), 7777);
  assert.equal(pi.maxTokens, 7777);
  assert.equal(pi.contextWindow, DEFAULT_CONTEXT_WINDOW);
});

// ---------- reasoning-aware defaults ----------

test("DEFAULT_MAX_TOKENS_REASONING is exported and strictly larger than DEFAULT_MAX_TOKENS", () => {
  assert.ok(typeof DEFAULT_MAX_TOKENS_REASONING === "number");
  assert.ok(DEFAULT_MAX_TOKENS_REASONING > DEFAULT_MAX_TOKENS);
});

test("getDefaultMaxTokens picks the non-reasoning constant when reasoning is unset", () => {
  assert.equal(getDefaultMaxTokens({ env: {} }), DEFAULT_MAX_TOKENS);
  assert.equal(getDefaultMaxTokens({ env: {}, reasoning: false }), DEFAULT_MAX_TOKENS);
});

test("getDefaultMaxTokens picks the reasoning constant when reasoning is true", () => {
  assert.equal(getDefaultMaxTokens({ env: {}, reasoning: true }), DEFAULT_MAX_TOKENS_REASONING);
});

test("COMMAND_CODE_DEFAULT_MAX_TOKENS applies uniformly to both reasoning and non-reasoning", () => {
  for (const r of [false, true]) {
    assert.equal(
      getDefaultMaxTokens({ env: { COMMAND_CODE_DEFAULT_MAX_TOKENS: "200000" }, reasoning: r }),
      200000,
      "env must win for reasoning=" + r
    );
  }
});

test("toPiModel auto-bumps maxTokens for reasoning models when /models omits max_tokens", () => {
  const pi = toPiModel({ id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", reasoning: true });
  assert.equal(pi.maxTokens, DEFAULT_MAX_TOKENS_REASONING);
});

test("toPiModel uses the smaller non-reasoning default for non-reasoning models", () => {
  const pi = toPiModel({ id: "gpt-5.5", name: "GPT-5.5" });
  assert.equal(pi.maxTokens, DEFAULT_MAX_TOKENS);
});

test("toPiModel honors /models max_tokens even for reasoning models (cannot overshoot)", () => {
  // /models is the authoritative low end; the reasoning-aware default must
  // not bump above it.
  const pi = toPiModel({ id: "r1", reasoning: true, maxTokens: 16384 });
  assert.equal(pi.maxTokens, 16384);
});

test("toPiModel per-model override beats the reasoning-aware default", () => {
  // If the user has already pinned a value in the override file, that
  // value is what reaches Pi — the reasoning default only kicks in when
  // nothing else applies.
  const overrides = new Map([["r1", { maxTokens: 50000 }]]);
  const pi = toPiModel({ id: "r1", reasoning: true }, overrides);
  assert.equal(pi.maxTokens, 50000);
});

// ---------- Claude-family extended thinking heuristic ----------

test("inferClaudeThinking returns undefined for non-Claude ids", () => {
  assert.equal(inferClaudeThinking({ id: "gpt-5.5" }), undefined);
  assert.equal(inferClaudeThinking({ id: "deepseek/deepseek-v4-pro" }), undefined);
  assert.equal(inferClaudeThinking({ id: "z-ai/glm-5.3-flash" }), undefined);
  assert.equal(inferClaudeThinking({ id: "" }), undefined);
  assert.equal(inferClaudeThinking({ id: undefined }), undefined);
  // Anything containing "claude" anywhere in the id is treated as Claude family.
  assert.notEqual(inferClaudeThinking({ id: "vendor/claude-tools" }), undefined);
});

test("inferClaudeThinking flags Opus 4.7 with xhigh mapping", () => {
  const meta = inferClaudeThinking({ id: "claude-opus-4-7" });
  assert.deepEqual(meta, { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
  // Dot-form id (anthropic's wire id style):
  assert.deepEqual(inferClaudeThinking({ id: "claude-opus-4.7-20251101" }), { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
});

test("inferClaudeThinking flags Sonnet 4.6 with xhigh mapping", () => {
  assert.deepEqual(inferClaudeThinking({ id: "claude-sonnet-4-6" }), { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
  assert.deepEqual(inferClaudeThinking({ id: "claude-sonnet-4.6" }), { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } });
});

test("inferClaudeThinking flags Opus 4.6 with max-effort mapping (max only valid on Opus 4.6)", () => {
  assert.deepEqual(inferClaudeThinking({ id: "claude-opus-4-6" }), { reasoning: true, thinkingLevelMap: { xhigh: "max" } });
  assert.deepEqual(inferClaudeThinking({ id: "claude-opus-4.6" }), { reasoning: true, thinkingLevelMap: { xhigh: "max" } });
});

test("inferClaudeThinking flags older Claude family as reasoning without xhigh", () => {
  // Older / future non-adaptive Claude: budget-based thinking.
  const meta = inferClaudeThinking({ id: "claude-haiku-4-5-20251001" });
  assert.deepEqual(meta, { reasoning: true });
  const meta2 = inferClaudeThinking({ id: "claude-sonnet-5" });
  assert.deepEqual(meta2, { reasoning: true });
});

test("toPiModel flips reasoning: true for Claude models that the heuristic flags", () => {
  // /models does not publish a reasoning flag for Claude, so without the
  // heuristic all Claude models would ship reasoning: false and Pi would
  // never enable extended thinking.
  const pi = toPiModel({ id: "claude-opus-4-7", name: "Claude Opus 4.7" });
  assert.equal(pi.reasoning, true);
  assert.deepEqual(pi.thinkingLevelMap, { xhigh: "xhigh" });
  // Reasoning-aware maxTokens fallback kicks in too:
  assert.equal(pi.maxTokens, DEFAULT_MAX_TOKENS_REASONING);
});

test("toPiModel does not set thinkingLevelMap for non-adaptive Claude", () => {
  const pi = toPiModel({ id: "claude-haiku-4-5-20251001" });
  assert.equal(pi.reasoning, true);
  assert.equal(pi.thinkingLevelMap, undefined);
});

test("toPiModel does not set thinkingLevelMap for non-Claude reasoning models", () => {
  // The map is Claude-specific. Non-Claude reasoning models (DeepSeek,
  // Kimi, etc.) are handled by the OpenAI-completions path with Pi's
  // defaults; introducing a map there would be over-fitting.
  const pi = toPiModel({ id: "deepseek/deepseek-v4-pro", reasoning: true });
  assert.equal(pi.reasoning, true);
  assert.equal(pi.thinkingLevelMap, undefined);
});

test("toPiModel respects enrichment reasoning: true even when the Claude heuristic disagrees", () => {
  // Defense-in-depth: a future enrichment source flagging a Claude model
  // as reasoning should still flow through. The heuristic and the
  // enrichment flag both contribute; either flipping reasoning to true
  // is sufficient.
  const pi = toPiModel({ id: "claude-some-future", reasoning: false });
  assert.equal(pi.reasoning, true);
});
