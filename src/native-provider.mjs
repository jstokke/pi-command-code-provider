/**
 * Native Pi provider wiring for Command Code.
 *
 * Produces a Provider object suitable for `pi.registerProvider()` that
 * participates in Pi's `/login` and `/logout` flows: masked secret input,
 * `auth.json` persistence, status display in the selector — all handled by
 * Pi itself once we expose the standard `auth.apiKey` block.
 *
 * Pure module: takes dependencies as args so tests can mock HTTP and the
 * auth.json reader. No top-level side effects.
 *
 * Two providers share one credential — both `check()`/`resolve()` read the
 * `command-code` key from `auth.json` (matching the historical behavior of
 * `readStoredApiKey("command-code", ...)`), so logging into either via
 * `/login` authenticates both.
 */

import {
  stream as compatStream,
  streamSimple as compatStreamSimple,
} from "@earendil-works/pi-ai/compat";
import {
  fetchCatalog as defaultFetchCatalog,
  loadModelOverrides as defaultLoadModelOverrides,
  readStoredApiKey,
  splitByWire,
  toPiModels,
} from "./core.mjs";
import {
  enrichCatalog,
  fetchEnrichment as defaultFetchEnrichment,
  getEnrichmentUrl,
  loadEnrichmentCache as defaultLoadEnrichmentCache,
  saveEnrichmentCache as defaultSaveEnrichmentCache,
} from "./enrich.mjs";

/**
 * Shape we expect Pi to pass into `login()` and the credential-related
 * callbacks. Pi's runtime types live in `@earendil-works/pi-ai` and aren't
 * exported as TS interfaces, so we declare what we use.
 *
 * @typedef {object} Interaction
 * @property {(opts: { type: "text" | "secret" | "select"; message: string; placeholder?: string; options?: Array<{ id: string; label: string }> }) => Promise<string>} prompt
 * @property {AbortSignal} [signal]
 *
 * @typedef {{ type: "api_key"; key: string }} ApiKeyCredential
 *
 * @typedef {object} AuthContext
 * @property {(name: string) => Promise<string | undefined>} env
 *
 * @typedef {object} RefreshModelsContext
 * @property {boolean} [allowNetwork]
 * @property {ApiKeyCredential | undefined} credential
 * @property {() => Promise<boolean>} publish
 * @property {{ models?: unknown[] } | undefined} stored
 * @property {AbortSignal} signal
 */

/**
 * Options for `createCommandCodeProvider`. All fields are dependency
 * injections for testability.
 *
 * @typedef {object} CreateProviderOptions
 * @property {string} id                       Provider id (e.g. "command-code")
 * @property {string} name                     Display name shown in Pi UI
 * @property {string} baseUrl                  baseUrl registered with Pi
 * @property {"openai-completions" | "anthropic-messages"} api  wire protocol
 * @property {typeof defaultFetchCatalog} [fetchCatalog]  Catalog fetcher (defaults to core.mjs)
 * @property {typeof defaultFetchEnrichment} [fetchEnrichmentFn]  Enrichment fetcher (defaults to enrich.mjs)
 * @property {typeof defaultLoadEnrichmentCache} [loadEnrichmentCacheFn]  Cache loader (defaults to enrich.mjs)
 * @property {typeof defaultSaveEnrichmentCache} [saveEnrichmentCacheFn]  Cache writer (defaults to enrich.mjs)
 * @property {typeof defaultLoadModelOverrides} [loadModelOverridesFn]  Per-model overrides loader
 * @property {(id: string, authPath?: string) => string | undefined} [readStoredApiKeyFn]
 *   Auth.json reader (defaults to core.mjs readStoredApiKey)
 * @property {Record<string, string>} [extraHeaders]  Extra headers for every request (e.g. ZDR)
 */

/**
 * Resolve the API key for this provider, in the documented order:
 *   1. auth.json credential passed in by Pi (this provider's key)
 *   2. auth.json credential for the shared "command-code" key (fallback
 *      so logging into the openai provider also unblocks the anthropic
 *      provider and vice versa)
 *   3. COMMAND_CODE_API_KEY env var
 * Returns undefined when no source has a key. Never throws.
 */
function resolveKey(credential, readStoredApiKeyFn) {
  const fromProvider = credential?.key;
  const storedShared =
    !fromProvider && readStoredApiKeyFn
      ? readStoredApiKeyFn("command-code")
      : undefined;
  const envKey =
    !fromProvider && !storedShared
      ? (process.env.COMMAND_CODE_API_KEY || "").trim()
      : undefined;
  return fromProvider ?? storedShared ?? (envKey || undefined);
}

/**
 * Label the source for `/login`'s status display. Callers only invoke this
 * after resolveKey() returned a key, so the final fallback is unreachable
 * in practice — it exists to keep the return type a plain string.
 */
function resolveSource(credential, readStoredApiKeyFn) {
  if (credential?.key) return "stored credential";
  if (readStoredApiKeyFn && readStoredApiKeyFn("command-code")) return "stored credential";
  const env = (process.env.COMMAND_CODE_API_KEY || "").trim();
  return env ? "COMMAND_CODE_API_KEY" : "stored credential";
}

/**
 * Creates one Command Code provider (one wire protocol). Two of these are
 * registered per extension — one for `openai-completions`, one for
 * `anthropic-messages`. Both share the same `command-code` auth.json key.
 *
 * The returned object is the runtime `Provider` shape Pi accepts via
 * `registerProvider`. The catalog fetch is lazy — Pi calls
 * `refreshModels()` on first model use and on `/model` refresh, never at
 * extension startup.
 *
 * @param {CreateProviderOptions} options
 */
export function createCommandCodeProvider(options) {
  const {
    id,
    name,
    baseUrl,
    api,
    fetchCatalog = defaultFetchCatalog,
    fetchEnrichmentFn = defaultFetchEnrichment,
    loadEnrichmentCacheFn = defaultLoadEnrichmentCache,
    saveEnrichmentCacheFn = defaultSaveEnrichmentCache,
    loadModelOverridesFn = defaultLoadModelOverrides,
    readStoredApiKeyFn = readStoredApiKey,
    extraHeaders,
  } = options;

  // Per-model overrides are read once at provider creation; Pi passes the
  // same Map across refreshModels calls in the same session.
  const modelOverrides = loadModelOverridesFn();

  // Per-provider catalog. Empty until the first `refreshModels()` restores
  // the persisted snapshot or a live fetch publishes one.
  let models = [];

  /** Provider-scoped metadata stamped onto every model we publish. */
  const modelMeta = { provider: id, api, baseUrl };

  /**
   * Normalize a persisted model entry for this provider. Legacy entries
   * (written before provider/api/baseUrl were stamped) are backfilled; an
   * entry claiming a different provider is dropped rather than cross-wired.
   */
  function normalizeStoredModel(entry) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.trim() === "") return undefined;
    if (entry.provider !== undefined && entry.provider !== id) return undefined;
    return {
      ...entry,
      provider: id,
      api: entry.api ?? api,
      baseUrl: entry.baseUrl ?? baseUrl,
    };
  }

  /**
   * Build the `auth.apiKey` block. Both providers expose this so `/login`
   * shows both in the selector and either login authenticates both via the
   * shared `command-code` auth.json key.
   */
  function buildAuthMethod() {
    return {
      name,
      async login(interaction) {
        const entered = (
          await interaction.prompt({
            type: "secret",
            message: `${name} API key`,
            placeholder: "sk-…",
          })
        ).trim();
        if (!entered) {
          throw new Error(`${name}: empty API key — login cancelled.`);
        }
        // Validate by hitting /models with the new key. Surfaces 401/403
        // immediately so we don't persist a bad key.
        await fetchCatalog({
          apiKey: entered,
          timeoutMs: 8000,
          signal: interaction.signal,
        });
        return { type: "api_key", key: entered };
      },
      async check({ ctx, credential }) {
        const key = resolveKey(credential, readStoredApiKeyFn);
        void ctx;
        return key ? { type: "api_key", source: resolveSource(credential, readStoredApiKeyFn) } : undefined;
      },
      async resolve({ ctx, credential }) {
        const key = resolveKey(credential, readStoredApiKeyFn);
        void ctx;
        if (!key) return undefined;
        return {
          auth: { apiKey: key, ...(extraHeaders ? { headers: extraHeaders } : {}) },
          source: resolveSource(credential, readStoredApiKeyFn),
        };
      },
    };
  }

  return {
    id,
    name,
    baseUrl,
    api,
    ...(extraHeaders ? { headers: extraHeaders } : {}),
    auth: {
      apiKey: buildAuthMethod(),
    },
    getModels: () => models,
    // Native providers without a models.json overlay are used raw by Pi's
    // model runtime, so stream dispatch must live here. The compat
    // streamers pick the wire implementation from model.api (which every
    // published model carries) and receive the resolved apiKey/headers
    // through `options`.
    stream: (model, context, options) => compatStream(model, context, options),
    streamSimple: (model, context, options) => compatStreamSimple(model, context, options),
    async refreshModels(context) {
      // Offline restore first: Pi runs a cache-only refresh phase at
      // startup (before login and before any network access). Republishing
      // the persisted catalog keeps /model populated even when the network
      // phase is skipped or fails — matching pi's own remote catalog and
      // llama.cpp providers.
      const storedModels = Array.isArray(context.stored?.models) ? context.stored.models : [];
      if (storedModels.length > 0) {
        const restored = storedModels.map(normalizeStoredModel).filter((m) => m !== undefined);
        if (restored.length > 0) {
          const ok = await context.publish({
            update: () => {
              models = restored;
            },
          });
          if (!ok) return;
        }
      }

      if (!context.allowNetwork) return;
      if (context.signal.aborted) return;
      // Mirror check()/resolve() key resolution: the Pi credential first,
      // then the shared auth.json key, then COMMAND_CODE_API_KEY — so
      // headless env-var setups still get a live catalog on /model refresh.
      const apiKey = resolveKey(context.credential, readStoredApiKeyFn);
      if (!apiKey) return;

      // Mirror the historical startup flow: fetch /models concurrently with
      // an enrichment refresh, bounded 8s each. Pi's signal cancels cleanly.
      const cached = loadEnrichmentCacheFn();
      const enrichmentDisabled = process.env.COMMAND_CODE_NO_ENRICHMENT === "1";
      const needEnrichment = !enrichmentDisabled && (!cached || cached.stale);

      const enrichmentPromise = needEnrichment
        ? fetchEnrichmentFn({ url: getEnrichmentUrl() })
        : Promise.resolve(cached ? cached.entries : undefined);

      let catalogResult, enrichmentResult;
      try {
        [catalogResult, enrichmentResult] = await Promise.allSettled([
          fetchCatalog({ apiKey, signal: context.signal }),
          enrichmentPromise,
        ]);
      } catch (err) {
        console.error(`Command Code: ${id} refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }

      if (context.signal.aborted) return;

      if (catalogResult.status === "rejected") {
        const reason = catalogResult.reason instanceof Error ? catalogResult.reason.message : String(catalogResult.reason);
        console.error(`Command Code: ${id} catalog fetch failed: ${reason}`);
        return;
      }

      let entries = cached?.entries;
      if (enrichmentResult.status === "fulfilled") {
        entries = enrichmentResult.value;
        if (needEnrichment && entries) {
          saveEnrichmentCacheFn(entries, { source: getEnrichmentUrl() });
        }
      } else if (needEnrichment) {
        const reason =
          enrichmentResult.reason instanceof Error
            ? enrichmentResult.reason.message
            : String(enrichmentResult.reason);
        console.error(
          `${reason} (using ${entries ? "stale cached metadata" : "conservative defaults"})`
        );
      }

      // Reuse core.mjs's canonical split — keeps Claude heuristic,
      // reasoning-aware maxTokens bump, and per-model overrides consistent
      // with the historical startup flow.
      const catalog = enrichCatalog(catalogResult.value, entries);
      const { openaiModels, anthropicModels } = splitByWire(catalog);
      const sliced = api === "openai-completions" ? openaiModels : anthropicModels;
      const filtered = toPiModels(sliced, modelOverrides, undefined, modelMeta);

      // Pi's publish() can return false (e.g. when cancelled mid-update);
      // only persist when it succeeds so we don't write a stale snapshot.
      const published = await context.publish({
        update: () => {
          models = filtered;
        },
      });
      if (!published) return;

      await context.publish({
        persist: { models: filtered, checkedAt: Date.now() },
      });

      models = filtered;
    },
  };
}
