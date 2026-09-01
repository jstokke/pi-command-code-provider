/**
 * Enrichment layer: scrapes Command Code's GOAT plan model table
 * (https://commandcode.ai/docs/plans/goat) for pricing and capability
 * metadata that /models does not provide, with a TTL cache so the page is
 * fetched at most once per TTL window per startup.
 *
 * This is best-effort: the page covers in-plan models only (e.g. no Claude),
 * and any parse failure just leaves models with conservative defaults.
 * Everything here is key-free — no API key is ever sent to the docs site.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENRICHMENT_URL = "https://commandcode.ai/docs/plans/goat";
export const ENRICHMENT_TTL_MS = 24 * 60 * 60 * 1000;
export const ENRICHMENT_TIMEOUT_MS = 8000;

/** Header signature of the GOAT models table; guards against layout changes. */
const EXPECTED_HEADER = ["model", "context", "intelligence", "tok/s", "input", "output", "cache read", "cache write", "caps"];

/**
 * Resolve the enrichment source URL. Order: `COMMAND_CODE_ENRICHMENT_URL` env
 * var (trimmed, non-empty), else the compile-time default. The override is
 * intended for resilience against docs-page restructuring — users can pin a
 * working URL or a local mirror when the published table changes shape.
 */
export function getEnrichmentUrl({ env = process.env } = {}) {
  const raw = env.COMMAND_CODE_ENRICHMENT_URL;
  if (typeof raw === "string" && raw.trim() !== "") {
    return raw.trim();
  }
  return ENRICHMENT_URL;
}

export function defaultCachePath({ env = process.env } = {}) {
  const base = env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(base, "command-code-enrichment-cache.json");
}

export class EnrichmentError extends Error {
  constructor(message) {
    super(message);
    this.name = "EnrichmentError";
  }
}

function stripTags(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * "$0.15" → 0.15; "Free" → 0; "—"/"-" → 0 (no priced tier exists for that
 * column, e.g. cache writes the model doesn't support); empty/garbage →
 * undefined.
 */
export function parsePrice(text) {
  const value = stripTags(text);
  if (!value) return undefined;
  if (value === "—" || value === "-") return 0;
  if (/^free$/i.test(value)) return 0;
  const match = value.match(/\$?([0-9]+(?:\.[0-9]+)?)/);
  if (!match) return undefined;
  return Number(match[1]);
}

/** "1M" → 1000000, "256K" → 256000, "1,048,576"/"1048576" → number. */
export function parseContext(text) {
  const value = stripTags(text).replace(/,/g, "").toUpperCase();
  const match = value.match(/^([0-9]+(?:\.[0-9]+)?)\s*([KM])?$/);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return undefined;
  if (match[2] === "M") return Math.round(n * 1_000_000);
  if (match[2] === "K") return Math.round(n * 1_000);
  return n;
}

export function normalizeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Parse the GOAT models table out of the page HTML.
 * Rows are matched by header signature, not table position.
 * Returns { entries: Map<normalizedName, entry>, rowCount }.
 * Throws EnrichmentError when the expected table cannot be found.
 */
export function parseEnrichmentHtml(html) {
  if (typeof html !== "string" || html === "") {
    throw new EnrichmentError("Command Code enrichment: empty response");
  }
  const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/g)].map((m) => m[0]);
  let chosen = null;
  for (const table of tables) {
    const firstRow = table.match(/<tr[\s\S]*?<\/tr>/)?.[0];
    if (!firstRow) continue;
    const header = [...firstRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) =>
      stripTags(c[1]).toLowerCase()
    );
    // Header cells often carry sort affordances like "model↕"; match by
    // substring so layout variations don't break the parser.
    if (EXPECTED_HEADER.every((h) => header.some((cell) => cell.includes(h)))) {
      chosen = table;
      break;
    }
  }
  if (!chosen) {
    throw new EnrichmentError("Command Code enrichment: models table not found on page (layout may have changed)");
  }

  const entries = new Map();
  const rows = [...chosen.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) => r[0]);
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length < EXPECTED_HEADER.length - 1) continue;
    const name = stripTags(cells[0]);
    if (!name) continue;
    // Capabilities live in an aria-label inside the row: "Capabilities: Text input, Vision, Reasoning".
    const capsLabel = row.match(/aria-label="Capabilities:\s*([^"]+)"/)?.[1] ?? "";
    const caps = capsLabel.toLowerCase();
    entries.set(normalizeName(name), {
      name,
      context: parseContext(cells[1]),
      intelligence: stripTags(cells[2]),
      input: parsePrice(cells[4]),
      output: parsePrice(cells[5]),
      cacheRead: parsePrice(cells[6]),
      cacheWrite: parsePrice(cells[7]),
      vision: /vision/.test(caps),
      reasoning: /reasoning/.test(caps),
    });
  }
  if (entries.size === 0) {
    throw new EnrichmentError("Command Code enrichment: models table found but contains no rows");
  }
  return entries;
}

/** Fetch the enrichment page. Throws EnrichmentError on failure; never sends secrets. */
export async function fetchEnrichment({
  url,
  timeoutMs = ENRICHMENT_TIMEOUT_MS,
  fetchImpl = fetch,
} = {}) {
  const resolvedUrl = url ?? getEnrichmentUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  let response;
  try {
    response = await fetchImpl(resolvedUrl, { headers: { Accept: "text/html" }, signal: controller.signal });
  } catch (err) {
    const reason = controller.signal.aborted
      ? `request timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new EnrichmentError(`Command Code enrichment failed: ${reason}`);
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new EnrichmentError(`Command Code enrichment failed: HTTP ${response.status}`);
  }
  const html = await response.text();
  return parseEnrichmentHtml(html);
}

/** Load the TTL cache; returns { entries, fetchedAt, stale } or null. Never throws. */
export function loadEnrichmentCache({
  cachePath = defaultCachePath(),
  now = Date.now(),
  ttlMs = ENRICHMENT_TTL_MS,
} = {}) {
  try {
    const data = JSON.parse(readFileSync(cachePath, "utf8"));
    if (!data || typeof data !== "object" || !Array.isArray(data.entries) || typeof data.fetchedAt !== "number") {
      return null;
    }
    const entries = new Map(data.entries.map((e) => [normalizeName(e.name), e]));
    return { entries, fetchedAt: data.fetchedAt, stale: now - data.fetchedAt > ttlMs };
  } catch {
    return null;
  }
}

/** Persist enrichment entries; failures are silently non-fatal. */
export function saveEnrichmentCache(entries, { cachePath = defaultCachePath(), now = Date.now(), source } = {}) {
  try {
    mkdirSync(join(cachePath, ".."), { recursive: true });
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: now, source: source ?? ENRICHMENT_URL, entries: [...entries.values()] }, null, 2)
    );
  } catch {
    // Cache write failure must never break provider registration.
  }
}

/**
 * Merge enrichment metadata into normalized /models catalog entries (returning
 * new objects — input is not mutated). Match key: normalized display name.
 * Authoritative /models fields are never overwritten; the page only fills
 * gaps and pricing/capabilities.
 */
export function enrichCatalog(models, entries) {
  if (!entries) return models;
  return models.map((model) => {
    const hit = entries.get(normalizeName(model.name ?? model.id)) ?? entries.get(normalizeName(model.id));
    if (!hit) return model;
    return {
      ...model,
      contextLength: model.contextLength ?? hit.context,
      pricing: {
        input: hit.input ?? 0,
        output: hit.output ?? 0,
        cacheRead: hit.cacheRead ?? 0,
        cacheWrite: hit.cacheWrite ?? 0,
      },
      vision: hit.vision,
      reasoning: hit.reasoning,
    };
  });
}
