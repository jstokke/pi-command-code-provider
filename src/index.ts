/**
 * Command Code — dynamic custom provider for Pi.
 *
 * Fetches the live model catalog from Command Code at Pi startup and exposes
 * it as two logical providers backed by the same account:
 *
 *   command-code            → OpenAI Chat Completions wire (openai-completions)
 *   command-code-anthropic  → Anthropic Messages wire (anthropic-messages)
 *
 * Auth: COMMAND_CODE_API_KEY env var, or the stored "command-code" api_key
 * credential in Pi's auth.json. The key is resolved at runtime and never
 * hardcoded or logged.
 *
 * Metadata: /models supplies id/name/context. Pricing and Vision/Reasoning
 * capabilities are enriched from Command Code's published GOAT model table
 * (https://commandcode.ai/docs/plans/goat), cached with a 24h TTL so the page
 * is scraped at most once a day; a stale cache is used if the refresh fails.
 * Models the page does not cover keep conservative defaults.
 *
 * Per-model output limits: loadModelOverrides() reads
 * ~/.pi/agent/command-code-model-overrides.json so users can raise
 * maxTokens above whatever /models reports (Command Code's authoritative
 * cap is the floor; the override can only raise it). The env var
 * COMMAND_CODE_DEFAULT_MAX_TOKENS raises the global fallback default.
 * See core.mjs for the resolution order.
 *
 * ZDR: set CMD_ZDR=1 to send the "x-cmd-zdr: 1" header on every request.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  ANTHROPIC_BASE_URL,
  OPENAI_BASE_URL,
  DiscoveryError,
  defaultOverridesPath,
  fetchCatalog,
  loadModelOverrides,
  resolveApiKey,
  splitByWire,
  toPiModels,
} from "./core.mjs";
import {
  EnrichmentEntry,
  EnrichmentError,
  enrichCatalog,
  fetchEnrichment,
  getEnrichmentUrl,
  loadEnrichmentCache,
  saveEnrichmentCache,
} from "./enrich.mjs";

export default async function (pi: ExtensionAPI) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    console.error(
      "Command Code: COMMAND_CODE_API_KEY is not set (and no stored credential for 'command-code' in auth.json); provider not registered."
    );
    return;
  }

  // Load per-model overrides (maxTokens / contextWindow) once at startup.
  // Missing or empty file is silent; only a malformed file logs.
  const modelOverrides = loadModelOverrides();

  const cached = loadEnrichmentCache();
  const enrichmentDisabled = process.env.COMMAND_CODE_NO_ENRICHMENT === "1";
  const needEnrichment = !enrichmentDisabled && (!cached || cached.stale);

  // Discovery and (when due) the enrichment refresh run concurrently so total
  // startup latency stays bounded by the longer of the two timeouts.
  const enrichmentPromise: Promise<Map<string, EnrichmentEntry> | undefined> = needEnrichment
    ? fetchEnrichment({ url: getEnrichmentUrl() })
    : Promise.resolve(cached ? cached.entries : undefined);
  const [catalogResult, enrichmentResult] = await Promise.allSettled([
    fetchCatalog({ apiKey }),
    enrichmentPromise,
  ]);

  if (catalogResult.status === "rejected") {
    const err = catalogResult.reason;
    const message =
      err instanceof DiscoveryError
        ? err.message
        : "Command Code: model discovery failed: " + (err instanceof Error ? err.message : String(err));
    console.error(message);
    return;
  }

  let entries = cached?.entries;
  if (enrichmentResult.status === "fulfilled") {
    entries = enrichmentResult.value;
    // Refresh succeeded: persist so the next startups read from cache. Stash
    // the source URL too — if the env override changes, the next load can
    // tell stale entries apart from fresh ones.
    if (needEnrichment && entries) {
      saveEnrichmentCache(entries, { source: getEnrichmentUrl() });
    }
  } else if (needEnrichment) {
    const reason =
      enrichmentResult.reason instanceof EnrichmentError
        ? enrichmentResult.reason.message
        : enrichmentResult.reason instanceof Error
          ? enrichmentResult.reason.message
          : String(enrichmentResult.reason);
    console.error(reason + " (using " + (entries ? "stale cached metadata" : "conservative defaults") + ")");
  }

  const catalog = enrichCatalog(catalogResult.value, entries);
  const { openaiModels, anthropicModels } = splitByWire(catalog);
  const headers = process.env.CMD_ZDR === "1" ? { "x-cmd-zdr": "1" } : undefined;

  if (modelOverrides.size > 0) {
    console.error(
      "Command Code: applying " + modelOverrides.size + " per-model override(s) from " + defaultOverridesPath() + "."
    );
  }

  let registered = 0;
  if (openaiModels.length > 0) {
    pi.registerProvider("command-code", {
      name: "Command Code",
      baseUrl: OPENAI_BASE_URL,
      apiKey,
      api: "openai-completions",
      models: toPiModels(openaiModels, modelOverrides),
      ...(headers ? { headers } : {}),
    });
    registered += openaiModels.length;
  }

  if (anthropicModels.length > 0) {
    pi.registerProvider("command-code-anthropic", {
      name: "Command Code (Anthropic)",
      baseUrl: ANTHROPIC_BASE_URL,
      apiKey,
      api: "anthropic-messages",
      models: toPiModels(anthropicModels, modelOverrides),
      ...(headers ? { headers } : {}),
    });
    registered += anthropicModels.length;
  }

  // Always log on success so users can spot a silent regression (empty catalog,
  // wrong baseUrl, classifier splitting everything one way, etc.) at startup.
  console.error(
    "Command Code: registered " +
      registered +
      " model(s) (" +
      openaiModels.length +
      " openai, " +
      anthropicModels.length +
      " anthropic)."
  );
}
