/**
 * Command Code provider — core logic (pure, testable, no Pi imports).
 *
 * Command Code API contract (https://commandcode.ai/docs/provider):
 *   GET  https://api.commandcode.ai/provider/v1/models   — live catalog
 *   POST https://api.commandcode.ai/provider/v1/chat/completions — OpenAI wire
 *   POST https://api.commandcode.ai/provider/v1/messages — Anthropic wire
 *
 * Invariant: models must use the endpoint matching their API format.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const PROVIDER_ROOT = "https://api.commandcode.ai/provider";
/** OpenAI SDK appends /chat/completions to baseUrl. */
export const OPENAI_BASE_URL = `${PROVIDER_ROOT}/v1`;
/** Anthropic SDK appends /v1/messages to baseURL. */
export const ANTHROPIC_BASE_URL = PROVIDER_ROOT;

/**
 * Conservative defaults for fields Command Code's /models does not supply.
 * They exist only because Pi's model definition requires them; they are not
 * claims about the models. Override per model via
 * ~/.pi/agent/command-code-model-overrides.json (see loadModelOverrides())
 * or COMMAND_CODE_DEFAULT_MAX_TOKENS (see getDefaultMaxTokens()).
 *
 * DEFAULT_MAX_TOKENS is set generously to keep reasoning models from being
 * truncated mid-stream (Pi raises "Response was truncated before completion."
 * when finish_reason=length is returned because the cap was too tight for
 * the model's thinking budget).
 */
/**
 * Non-reasoning output ceiling. Raised from 8192 (the historical value)
 * because Pi raised "Response was truncated before completion." on
 * models whose /models entry did not publish max_tokens.
 */
export const DEFAULT_CONTEXT_WINDOW = 200000;
export const DEFAULT_MAX_TOKENS = 65536;

/**
 * Reasoning-model output ceiling. The auto-bump exists because Pi's
 * truncation error disproportionately hits reasoning models — their
 * thinking budget can consume 30k-100k tokens before the final answer,
 * and a 65k ceiling still truncates mid-thought. The 128k value covers
 * Claude extended thinking, DeepSeek V4 reasoning, Kimi K-series, etc.
 * Applied only when /models omits max_tokens AND no override / env var
 * is set, so models with a known lower ceiling are never overshot.
 */
export const DEFAULT_MAX_TOKENS_REASONING = 131072;

/** Startup must stay bounded: single attempt, no meaningful retry delay. */
export const DISCOVERY_TIMEOUT_MS = 8000;

export class DiscoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = "DiscoveryError";
  }
}

/**
 * Resolve the Command Code API key without ever hardcoding it.
 * Order: COMMAND_CODE_API_KEY env var, then the stored "command-code"
 * credential in Pi's auth.json (type "api_key").
 */
export function resolveApiKey({ env = process.env, authPath } = {}) {
  const fromEnv = env.COMMAND_CODE_API_KEY;
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  return readStoredApiKey("command-code", authPath);
}

export function defaultAuthPath({ env = process.env } = {}) {
  const base = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "auth.json");
}

/**
 * Resolve the global maxTokens default.
 * Order: COMMAND_CODE_DEFAULT_MAX_TOKENS env var (positive integer), else
 * the compile-time DEFAULT_MAX_TOKENS constant. Invalid env values fall
 * back silently — the constant is always the floor.
 */
export function getDefaultMaxTokens({ env = process.env, reasoning = false } = {}) {
  const raw = env.COMMAND_CODE_DEFAULT_MAX_TOKENS;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    // Reject anything that is not pure digits so "12.5" / "1e3" / "abc"
    // fall back to the per-class default rather than being silently
    // truncated by parseInt.
    if (trimmed !== "" && /^[0-9]+$/.test(trimmed)) {
      const n = Number.parseInt(trimmed, 10);
      if (Number.isInteger(n) && n > 0) return n;
    }
  }
  // No env var (or invalid): pick the per-class default. Reasoning models
  // get a higher ceiling because their thinking budget can consume tens of
  // thousands of tokens before the final answer.
  return reasoning ? DEFAULT_MAX_TOKENS_REASONING : DEFAULT_MAX_TOKENS;
}

/** Path to the optional per-model override file (see README). */
export function defaultOverridesPath({ env = process.env } = {}) {
  const base = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "command-code-model-overrides.json");
}

/** Positive integer or undefined; everything else is rejected. */
function validatePositiveInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Clean a single override entry. Returns undefined if no usable fields. */
function normalizeOverride(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const maxTokens = validatePositiveInt(entry.maxTokens);
  const contextWindow = validatePositiveInt(entry.contextWindow);
  if (maxTokens === undefined && contextWindow === undefined) return undefined;
  return { maxTokens, contextWindow };
}

/**
 * Load per-model overrides from JSON. Keys can be exact model ids or
 * normalized display names (whitespace + punctuation stripped, lowercased)
 * so users do not have to match the catalog's name formatting exactly.
 * Id wins on conflict. Missing file → empty Map. Malformed JSON or wrong
 * top-level shape logs one line and returns an empty Map; a single bad
 * entry is silently dropped.
 */
export function loadModelOverrides({
  path = defaultOverridesPath(),
  fsImpl = { readFileSync },
} = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(path, "utf8");
  } catch {
    return new Map();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error("Command Code: ignoring " + path + ": not valid JSON.");
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error("Command Code: ignoring " + path + ": expected a JSON object at the top level.");
    return new Map();
  }
  const out = new Map();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof key !== "string" || key.trim() === "") continue;
    const cleaned = normalizeOverride(value);
    if (!cleaned) continue;
    const exact = key.trim();
    if (!out.has(exact)) out.set(exact, cleaned);
    const normalized = exact.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized && !out.has(normalized)) out.set(normalized, cleaned);
  }
  return out;
}
export function readStoredApiKey(providerId, authPath = defaultAuthPath()) {
  try {
    const data = JSON.parse(readFileSync(authPath, "utf8"));
    const cred = data?.[providerId];
    if (cred && cred.type === "api_key" && typeof cred.key === "string" && cred.key !== "") {
      return cred.key;
    }
  } catch {
    // Missing or unreadable auth.json is not fatal; caller reports a
    // missing-key diagnostic instead.
  }
  return undefined;
}

/**
 * Fetch and parse the live catalog. Throws DiscoveryError with a concise,
 * key-free message on auth failure, HTTP failure, timeout, or malformed body.
 */
export async function fetchCatalog({
  apiKey,
  url = `${PROVIDER_ROOT}/v1/models`,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  if (!apiKey) {
    throw new DiscoveryError(
      "Command Code: COMMAND_CODE_API_KEY is not set (and no stored credential for 'command-code' in auth.json); provider not registered."
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    const reason = controller.signal.aborted
      ? `request timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new DiscoveryError(`Command Code: model discovery failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new DiscoveryError(
      `Command Code: authentication failed (HTTP ${response.status}). Check COMMAND_CODE_API_KEY or the stored credential — the key itself is never logged.`
    );
  }
  if (!response.ok) {
    throw new DiscoveryError(`Command Code: model discovery failed: HTTP ${response.status}`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (err) {
    throw new DiscoveryError(
      `Command Code: model discovery failed: response is not valid JSON (${err instanceof Error ? err.message : String(err)})`
    );
  }
  return parseCatalog(payload);
}

/** Validate and normalize the /models payload. Throws on malformed input. */
export function parseCatalog(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new DiscoveryError("Command Code: model discovery failed: response is not a JSON object");
  }
  const data = payload.data;
  if (!Array.isArray(data)) {
    throw new DiscoveryError("Command Code: model discovery failed: response is missing a 'data' array");
  }
  const models = [];
  for (const [index, entry] of data.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new DiscoveryError(`Command Code: model discovery failed: data[${index}] is not an object`);
    }
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new DiscoveryError(`Command Code: model discovery failed: data[${index}] has no model id`);
    }
    models.push({
      id: entry.id,
      name: typeof entry.name === "string" && entry.name !== "" ? entry.name : undefined,
      ownedBy: typeof entry.owned_by === "string" ? entry.owned_by : undefined,
      contextLength: typeof entry.context_length === "number" && Number.isFinite(entry.context_length) && entry.context_length > 0
        ? entry.context_length
        : undefined,
      maxTokens: typeof entry.max_tokens === "number" && Number.isFinite(entry.max_tokens) && entry.max_tokens > 0
        ? entry.max_tokens
        : undefined,
      // Honor an explicit wire-format field if Command Code ever adds one.
      apiType: typeof entry.api_type === "string" ? entry.api_type : undefined,
    });
  }
  if (models.length === 0) {
    throw new DiscoveryError("Command Code: model discovery failed: catalog is empty");
  }
  return models;
}

/**
 * Isolated protocol classifier: which Command Code endpoint a model must use.
 * Order: explicit api_type field → vendor/ownership metadata → model-id match
 * (claude*) → documented default (OpenAI Chat Completions for everything else).
 */
export function classifyWire(model) {
  const apiType = (model.apiType || "").toLowerCase();
  if (apiType === "anthropic" || apiType === "anthropic-messages" || apiType === "messages") {
    return "anthropic";
  }
  if (apiType === "openai" || apiType === "openai-completions" || apiType === "chat") {
    return "openai";
  }
  const ownedBy = (model.ownedBy || "").toLowerCase();
  if (ownedBy.includes("anthropic")) {
    return "anthropic";
  }
  if (/(^|\/)claude/i.test(model.id)) {
    return "anthropic";
  }
  // Command Code documents that OpenAI and open-source models are served
  // through /chat/completions; only claude-family models use /messages.
  return "openai";
}

/** Split a normalized catalog into the two wire-protocol buckets. */
export function splitByWire(models) {
  const openaiModels = [];
  const anthropicModels = [];
  for (const model of models) {
    (classifyWire(model) === "anthropic" ? anthropicModels : openaiModels).push(model);
  }
  return { openaiModels, anthropicModels };
}

/**
 * Vision is enabled only where it is known: enrichment metadata (GOAT page
 * capabilities) when available, otherwise a name match in the catalog itself.
 */
function isVisionModel(model) {
  if (typeof model.vision === "boolean") return model.vision;
  return /(vision|\bvlm?\b)/i.test(model.id + " " + (model.name ?? ""));
}

/**
 * Best-effort Claude-family reasoning capability for Pi.
 *
 * Command Code's /models endpoint does not publish extended-thinking
 * capability flags, and the GOAT enrichment page does not cover Claude at
 * all — so without a heuristic, every Claude model ships with
 * `reasoning: false` and Pi never enables extended thinking. That defeats
 * the 128k maxTokens bump this extension otherwise applies.
 *
 * The shapes below mirror Pi's `supportsAdaptiveThinking()` and Anthropic's
 * adaptive-effort vocabulary:
 *   - Opus 4.7  → { xhigh: "xhigh" }  (highest reasoning level)
 *   - Sonnet 4.6 → { xhigh: "xhigh" }
 *   - Opus 4.6  → { xhigh: "max" }    ("max" is Opus 4.6-only)
 *   - Older Claude → reasoning: true, no xhigh map (Pi hides xhigh; budget-
 *                   based thinking is used by the provider)
 *
 * Pi's `getSupportedThinkingLevels` filters xhigh out unless the map
 * contains an explicit entry, so the map is what exposes the top thinking
 * level in the UI. Returning `reasoning: true` without a map still enables
 * off/minimal/low/medium/high.
 *
 * Returns `undefined` for non-Claude models; caller keeps the prior
 * reasoning flag (typically the enrichment-supplied one).
 */
export function inferClaudeThinking(model) {
  const id = String(model?.id || "").toLowerCase();
  if (!/claude/.test(id)) return undefined;
  if (/opus-4-7|opus-4\.7/.test(id)) {
    return { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
  }
  if (/sonnet-4-6|sonnet-4\.6/.test(id)) {
    return { reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
  }
  if (/opus-4-6|opus-4\.6/.test(id)) {
    return { reasoning: true, thinkingLevelMap: { xhigh: "max" } };
  }
  // Older Claude family (Sonnet 4.x and earlier, Haiku, etc.): budget-based
  // thinking. Pi still exposes off/minimal/low/medium/high without a map.
  return { reasoning: true };
}

/**
 * Look up a per-model override by exact id, then by normalized display
 * name. Returns undefined when no override applies.
 */
function lookupOverride(overrides, model) {
  if (!(overrides instanceof Map) || overrides.size === 0) return undefined;
  const byId = overrides.get(model.id);
  if (byId) return byId;
  const normalized = String(model.name ?? model.id).toLowerCase().replace(/[^a-z0-9]/g, "");
  return overrides.get(normalized);
}

/**
 * Resolve a numeric cap (maxTokens / contextWindow):
 *   1. /models value is authoritative on the LOW end (Command Code knows
 *      its own model's hard ceiling).
 *   2. Per-model override may raise the cap if larger.
 *   3. Else the per-class fallback — DEFAULT_MAX_TOKENS_REASONING (131072)
 *      when model.reasoning is true, DEFAULT_MAX_TOKENS (65536) otherwise.
 *      COMMAND_CODE_DEFAULT_MAX_TOKENS overrides both uniformly.
 */
function pickCap({ fromApi, overrideEntry, field, fallback }) {
  if (fromApi !== undefined) {
    const raised = overrideEntry ? overrideEntry[field] : undefined;
    return raised !== undefined && raised > fromApi ? raised : fromApi;
  }
  const raised = overrideEntry ? overrideEntry[field] : undefined;
  return raised !== undefined ? raised : fallback;
}

/**
 * Convert one normalized catalog entry (optionally enriched with pricing and
 * capability metadata from the GOAT page) into a Pi model definition.
 *
 * `overrides` (optional Map from loadModelOverrides) raises maxTokens or
 * contextWindow above whatever /models reports. `defaultMaxTokens` (optional)
 * pins the fallback for tests; otherwise getDefaultMaxTokens({ reasoning })
 * selects the per-class default (131072 reasoning, 65536 non-reasoning),
 * unless COMMAND_CODE_DEFAULT_MAX_TOKENS is set.
 */
export function toPiModel(model, overrides, defaultMaxTokens) {
  const hit = lookupOverride(overrides, model);
  // Merge reasoning capability from two places: enrichment metadata (the
  // GOAT page covers non-Claude reasoning models) and a Claude-family
  // heuristic (GOAT does not cover Claude). Either source can flip the
  // flag to true; only the Claude heuristic supplies a thinkingLevelMap.
  const claudeMeta = inferClaudeThinking(model);
  const reasoning = model.reasoning === true || (claudeMeta?.reasoning === true);
  // Resolve the fallback once per model. Tests can pin `defaultMaxTokens`
  // to bypass both the env var and the reasoning-aware constant.
  const fallbackMax = defaultMaxTokens ?? getDefaultMaxTokens({ reasoning });
  return {
    id: model.id, // Command Code's exact model ID is preserved verbatim.
    name: model.name ?? model.id,
    reasoning,
    // Only emit when set — Pi treats undefined as "use provider defaults".
    ...(claudeMeta?.thinkingLevelMap ? { thinkingLevelMap: claudeMeta.thinkingLevelMap } : {}),
    input: isVisionModel(model) ? ["text", "image"] : ["text"],
    // Pricing comes from enrichment metadata when available; 0 avoids
    // fabricating costs for models the enrichment source does not cover.
    cost: model.pricing ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: pickCap({
      fromApi: model.contextLength,
      overrideEntry: hit,
      field: "contextWindow",
      fallback: DEFAULT_CONTEXT_WINDOW,
    }),
    maxTokens: pickCap({
      fromApi: model.maxTokens,
      overrideEntry: hit,
      field: "maxTokens",
      fallback: fallbackMax,
    }),
  };
}

export function toPiModels(models, overrides, defaultMaxTokens) {
  return models.map((m) => toPiModel(m, overrides, defaultMaxTokens));
}
