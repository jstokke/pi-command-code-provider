/**
 * Unit tests for the native Pi provider wiring.
 *
 * Verifies the auth flow (login / check / resolve), the lazy catalog
 * fetch in refreshModels, the model split between the two wire protocols,
 * and the integration with Pi's credential semantics.
 *
 * Run: node --test
 * All HTTP, auth.json reads, and refreshModels.publish() are mocked.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createCommandCodeProvider } from "./native-provider.mjs";
import { parseCatalog } from "./core.mjs";

const SECRET = "cc-sk-test-0123456789abcdef";

/** Minimal catalog that exercises both wire protocols. */
function representativeCatalog() {
  return {
    data: [
      { id: "claude-opus-4-7", name: "Claude Opus 4.7", owned_by: "command-code", context_length: 1000000 },
      { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", owned_by: "command-code", context_length: 200000 },
      { id: "gpt-5.5", name: "GPT-5.5", owned_by: "command-code", context_length: 400000 },
      { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro", owned_by: "command-code", context_length: 1000000 },
      { id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash", owned_by: "command-code", context_length: 1048576 },
    ],
  };
}

/** Parse the representative through the real catalog parser. */
function parsedRepresentative() {
  return parseCatalog(representativeCatalog());
}

/** Build a fake Pi AuthInteraction that resolves prompts to `answer`. */
function fakeInteraction(answer = SECRET) {
  const prompts = [];
  return {
    signal: undefined,
    prompt: async (opts) => {
      prompts.push(opts);
      return answer;
    },
    _prompts: prompts,
  };
}

/** Build a refreshModels context with a stubbed publish(). */
function fakeRefreshContext({ apiKey, allowNetwork = true } = {}) {
  const state = { published: 0, persisted: 0, lastUpdate: null };
  const controller = new AbortController();
  return {
    ctx: {
      allowNetwork,
      // Pass `apiKey: null` to simulate "no credential". Passing
      // `apiKey: undefined` would trigger the destructuring default and
      // mask the test intent.
      credential: apiKey != null ? { type: "api_key", key: apiKey } : undefined,
      stored: undefined,
      signal: controller.signal,
      publish: async (opts) => {
        if (opts.update) {
          state.lastUpdate = opts.update;
          state.lastUpdate();
        }
        if (opts.persist !== undefined) state.persisted++;
        state.published++;
        return true;
      },
      // Stats read live counters via getters so the test sees the post-call
      // values, not a snapshot from when the context was built.
      _stats: {
        get published() { return state.published; },
        get persisted() { return state.persisted; },
        get lastUpdate() { return state.lastUpdate; },
      },
    },
    controller,
  };
}

/** Fresh factory wiring with every external dependency mocked. */
function makeProvider(opts = {}) {
  return createCommandCodeProvider({
    id: "command-code",
    name: "Command Code",
    baseUrl: "https://api.commandcode.ai/provider/v1",
    api: "openai-completions",
    fetchCatalog: async () => parsedRepresentative(),
    fetchEnrichmentFn: async () => new Map(),
    loadEnrichmentCacheFn: () => null,
    saveEnrichmentCacheFn: () => {},
    loadModelOverridesFn: () => new Map(),
    readStoredApiKeyFn: () => undefined,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// auth.apiKey shape
// ---------------------------------------------------------------------------

test("provider exposes auth.apiKey with name, login, check, resolve", () => {
  const p = makeProvider();
  assert.equal(typeof p.auth, "object");
  assert.equal(typeof p.auth.apiKey, "object");
  assert.equal(p.auth.apiKey.name, "Command Code");
  assert.equal(typeof p.auth.apiKey.login, "function");
  assert.equal(typeof p.auth.apiKey.check, "function");
  assert.equal(typeof p.auth.apiKey.resolve, "function");
});

test("provider exposes id, name, baseUrl, getModels, refreshModels", () => {
  const p = makeProvider({ id: "command-code", api: "openai-completions" });
  assert.equal(p.id, "command-code");
  assert.equal(p.name, "Command Code");
  assert.equal(p.baseUrl, "https://api.commandcode.ai/provider/v1");
  assert.deepEqual(p.getModels(), []);
  assert.equal(typeof p.refreshModels, "function");
});

test("extraHeaders is omitted from the provider when unset", () => {
  const p = makeProvider();
  assert.equal(p.headers, undefined);
});

test("extraHeaders is forwarded to the provider when set", () => {
  const p = makeProvider({ extraHeaders: { "x-cmd-zdr": "1" } });
  assert.deepEqual(p.headers, { "x-cmd-zdr": "1" });
});

// ---------------------------------------------------------------------------
// login()
// ---------------------------------------------------------------------------

test("login() prompts for a secret and returns { type: api_key, key }", async () => {
  const p = makeProvider();
  const interaction = fakeInteraction(SECRET);
  const credential = await p.auth.apiKey.login(interaction);
  assert.deepEqual(credential, { type: "api_key", key: SECRET });
  assert.equal(interaction._prompts[0].type, "secret");
  assert.match(interaction._prompts[0].message, /Command Code API key/);
});

test("login() rejects empty / whitespace input", async () => {
  const p = makeProvider();
  await assert.rejects(
    p.auth.apiKey.login(fakeInteraction("   ")),
    /empty API key/
  );
});

test("login() validates against /models and surfaces fetch failures", async () => {
  let attempts = 0;
  const p = makeProvider({
    fetchCatalog: async () => {
      attempts++;
      throw new Error("Command Code: authentication failed (HTTP 401).");
    },
  });
  await assert.rejects(
    p.auth.apiKey.login(fakeInteraction(SECRET)),
    /authentication failed \(HTTP 401\)/
  );
  assert.equal(attempts, 1, "login must validate by hitting /models");
});

test("login() succeeds when /models returns a valid catalog", async () => {
  const p = makeProvider({ fetchCatalog: async () => parseCatalog(representativeCatalog()) });
  const credential = await p.auth.apiKey.login(fakeInteraction(SECRET));
  assert.equal(credential.type, "api_key");
  assert.equal(credential.key, SECRET);
});

// ---------------------------------------------------------------------------
// check() / resolve() credential resolution
// ---------------------------------------------------------------------------

test("check() returns undefined when no key is configured anywhere", async () => {
  delete process.env.COMMAND_CODE_API_KEY;
  const p = makeProvider({ readStoredApiKeyFn: () => undefined });
  const status = await p.auth.apiKey.check({ ctx: {}, credential: undefined });
  assert.equal(status, undefined);
});

test("check() returns the stored credential status when auth.json has the key", async () => {
  const p = makeProvider({ readStoredApiKeyFn: () => SECRET });
  const status = await p.auth.apiKey.check({ ctx: {}, credential: undefined });
  assert.deepEqual(status, { type: "api_key", source: "stored credential" });
});

test("check() returns the env-var status when auth.json is empty", async () => {
  const orig = process.env.COMMAND_CODE_API_KEY;
  process.env.COMMAND_CODE_API_KEY = SECRET;
  try {
    const p = makeProvider({ readStoredApiKeyFn: () => undefined });
    const status = await p.auth.apiKey.check({ ctx: {}, credential: undefined });
    assert.deepEqual(status, { type: "api_key", source: "COMMAND_CODE_API_KEY" });
  } finally {
    if (orig === undefined) delete process.env.COMMAND_CODE_API_KEY;
    else process.env.COMMAND_CODE_API_KEY = orig;
  }
});

test("check() prefers the credential Pi passed in over auth.json/env", async () => {
  // Pi is the source of truth when it hands us a credential — we should
  // not double-resolve through auth.json.
  const calls = { authJsonReads: 0 };
  const p = makeProvider({
    readStoredApiKeyFn: () => {
      calls.authJsonReads++;
      return undefined;
    },
  });
  const status = await p.auth.apiKey.check({
    ctx: {},
    credential: { type: "api_key", key: SECRET },
  });
  assert.deepEqual(status, { type: "api_key", source: "stored credential" });
  assert.equal(calls.authJsonReads, 0, "should not re-read auth.json when Pi already gave us a credential");
});

test("resolve() returns undefined when no key is configured", async () => {
  delete process.env.COMMAND_CODE_API_KEY;
  const p = makeProvider({ readStoredApiKeyFn: () => undefined });
  const auth = await p.auth.apiKey.resolve({ ctx: {}, credential: undefined });
  assert.equal(auth, undefined);
});

test("resolve() falls back to the shared command-code key from auth.json", async () => {
  const p = makeProvider({ readStoredApiKeyFn: () => SECRET });
  const auth = await p.auth.apiKey.resolve({ ctx: {}, credential: undefined });
  assert.deepEqual(auth, { auth: { apiKey: SECRET }, source: "stored credential" });
});

test("resolve() falls back to COMMAND_CODE_API_KEY env var", async () => {
  const orig = process.env.COMMAND_CODE_API_KEY;
  process.env.COMMAND_CODE_API_KEY = SECRET;
  try {
    const p = makeProvider({ readStoredApiKeyFn: () => undefined });
    const auth = await p.auth.apiKey.resolve({ ctx: {}, credential: undefined });
    assert.deepEqual(auth, { auth: { apiKey: SECRET }, source: "COMMAND_CODE_API_KEY" });
  } finally {
    if (orig === undefined) delete process.env.COMMAND_CODE_API_KEY;
    else process.env.COMMAND_CODE_API_KEY = orig;
  }
});

test("resolve() prefers the credential Pi passed in over auth.json/env", async () => {
  const calls = { authJsonReads: 0 };
  const p = makeProvider({
    readStoredApiKeyFn: () => {
      calls.authJsonReads++;
      return SECRET;
    },
  });
  const auth = await p.auth.apiKey.resolve({
    ctx: {},
    credential: { type: "api_key", key: "pi-provided-key" },
  });
  assert.deepEqual(auth, { auth: { apiKey: "pi-provided-key" }, source: "stored credential" });
  assert.equal(calls.authJsonReads, 0);
});

test("shared auth.json key is read by both providers' check()", async () => {
  // The anthropic provider doesn't have its own auth.json entry — both
  // providers' check() must fall back to the shared "command-code" key.
  const openai = makeProvider({ id: "command-code", api: "openai-completions" });
  const anthropic = makeProvider({ id: "command-code-anthropic", api: "anthropic-messages", readStoredApiKeyFn: () => SECRET });
  const s1 = await openai.auth.apiKey.check({ ctx: {}, credential: undefined });
  const s2 = await anthropic.auth.apiKey.check({ ctx: {}, credential: undefined });
  assert.equal(s1, undefined, "openai provider without readStoredApiKeyFn sees nothing");
  assert.deepEqual(s2, { type: "api_key", source: "stored credential" });
});

// ---------------------------------------------------------------------------
// refreshModels() — lazy catalog fetch
// ---------------------------------------------------------------------------

test("refreshModels() is a no-op when allowNetwork is false", async () => {
  let fetched = 0;
  const p = makeProvider({
    fetchCatalog: async () => {
      fetched++;
      return [];
    },
  });
  const { ctx } = fakeRefreshContext({ allowNetwork: false });
  await p.refreshModels(ctx);
  assert.equal(fetched, 0);
  assert.deepEqual(p.getModels(), []);
});

test("refreshModels() is a no-op when the credential is missing", async () => {
  let fetched = 0;
  const p = makeProvider({
    fetchCatalog: async () => {
      fetched++;
      return [];
    },
  });
  const { ctx } = fakeRefreshContext({ apiKey: null });
  await p.refreshModels(ctx);
  assert.equal(fetched, 0);
});

test("refreshModels() fetches /models and populates getModels()", async () => {
  const p = makeProvider({
    api: "openai-completions",
    fetchCatalog: async () => parseCatalog(representativeCatalog()),
  });
  const { ctx } = fakeRefreshContext({ apiKey: SECRET });
  await p.refreshModels(ctx);
  const models = p.getModels();
  assert.ok(models.length > 0);
  // Only openai-side models for this provider (no claude)
  for (const m of models) {
    assert.equal(/claude/i.test(m.id), false, `unexpected claude in openai provider: ${m.id}`);
  }
});

test("refreshModels() filters to anthropic-only models for the anthropic provider", async () => {
  const p = makeProvider({
    id: "command-code-anthropic",
    api: "anthropic-messages",
    fetchCatalog: async () => parseCatalog(representativeCatalog()),
  });
  const { ctx } = fakeRefreshContext({ apiKey: SECRET });
  await p.refreshModels(ctx);
  const models = p.getModels();
  assert.ok(models.length > 0);
  for (const m of models) {
    assert.match(m.id, /claude/i, `expected claude id in anthropic provider, got: ${m.id}`);
  }
});

test("refreshModels() persists the catalog so Pi can restore it across sessions", async () => {
  const p = makeProvider({
    fetchCatalog: async () => parseCatalog(representativeCatalog()),
  });
  const { ctx, controller } = fakeRefreshContext({ apiKey: SECRET });
  await p.refreshModels(ctx);
  assert.equal(ctx._stats.persisted, 1);
  assert.equal(ctx._stats.published, 2, "one update publish + one persist publish");
});

test("refreshModels() no-ops cleanly when the signal aborts before fetch", async () => {
  const p = makeProvider({
    fetchCatalog: async () => parseCatalog(representativeCatalog()),
  });
  const { ctx, controller } = fakeRefreshContext({ apiKey: SECRET });
  controller.abort();
  await p.refreshModels(ctx);
  assert.deepEqual(p.getModels(), []);
  assert.equal(ctx._stats.published, 0);
});

test("refreshModels() logs and no-ops on catalog fetch failure", async () => {
  const origError = console.error;
  const messages = [];
  console.error = (msg) => messages.push(msg);
  try {
    const p = makeProvider({
      fetchCatalog: async () => {
        throw new Error("DNS lookup failed");
      },
    });
    const { ctx } = fakeRefreshContext({ apiKey: SECRET });
    await p.refreshModels(ctx);
    assert.deepEqual(p.getModels(), []);
    assert.equal(ctx._stats.published, 0);
    // fetchCatalog's rejection surfaces through Promise.allSettled, not
    // through a try/catch — so the message is "catalog fetch failed".
    assert.ok(messages.some((m) => /catalog fetch failed/.test(m)));
  } finally {
    console.error = origError;
  }
});

test("refreshModels() logs the success count on completion", async () => {
  const origError = console.error;
  const messages = [];
  console.error = (msg) => messages.push(msg);
  try {
    const p = makeProvider({
      id: "command-code",
      api: "openai-completions",
      fetchCatalog: async () => parseCatalog(representativeCatalog()),
    });
    const { ctx } = fakeRefreshContext({ apiKey: SECRET });
    await p.refreshModels(ctx);
    assert.ok(messages.some((m) => /Command Code \(command-code\): refreshed \d+ model/.test(m)));
  } finally {
    console.error = origError;
  }
});

// ---------------------------------------------------------------------------
// model split — Claude heuristic + reasoning-aware defaults
// ---------------------------------------------------------------------------

test("anthropic provider exposes Claude Opus 4.7 with reasoning + thinkingLevelMap", async () => {
  const p = makeProvider({
    id: "command-code-anthropic",
    api: "anthropic-messages",
    fetchCatalog: async () => parseCatalog(representativeCatalog()),
  });
  const { ctx } = fakeRefreshContext({ apiKey: SECRET });
  await p.refreshModels(ctx);
  const opus = p.getModels().find((m) => m.id === "claude-opus-4-7");
  assert.ok(opus, "expected Claude Opus 4.7 in anthropic provider");
  assert.equal(opus.reasoning, true);
  assert.deepEqual(opus.thinkingLevelMap, { xhigh: "xhigh" });
});

test("anthropic provider exposes Claude Haiku as reasoning but without xhigh", async () => {
  const p = makeProvider({
    id: "command-code-anthropic",
    api: "anthropic-messages",
    fetchCatalog: async () => parseCatalog(representativeCatalog()),
  });
  const { ctx } = fakeRefreshContext({ apiKey: SECRET });
  await p.refreshModels(ctx);
  const haiku = p.getModels().find((m) => m.id === "claude-haiku-4-5-20251001");
  assert.ok(haiku);
  assert.equal(haiku.reasoning, true);
  assert.equal(haiku.thinkingLevelMap, undefined, "older Claude: no xhigh exposure");
});

test("openai provider preserves the GPT/DeepSeek/GLM catalog entries verbatim", async () => {
  const p = makeProvider({
    api: "openai-completions",
    fetchCatalog: async () => parseCatalog(representativeCatalog()),
  });
  const { ctx } = fakeRefreshContext({ apiKey: SECRET });
  await p.refreshModels(ctx);
  const ids = p.getModels().map((m) => m.id).sort();
  assert.deepEqual(ids, [
    "deepseek/deepseek-v4-pro",
    "gpt-5.5",
    "z-ai/glm-5.3-flash",
  ]);
});