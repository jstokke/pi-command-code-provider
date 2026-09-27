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

/**
 * Header columns required to uniquely identify the GOAT models table.
 * Matches by column name rather than position, so layout variations
 * (e.g. optional/removed "tok/s" column, reordered columns) parse cleanly.
 */
const REQUIRED_HEADERS = ["model", "context", "input", "output", "cache read", "cache write"];

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
  let colMap = null;
  for (const table of tables) {
    const firstRow = table.match(/<tr[\s\S]*?<\/tr>/)?.[0];
    if (!firstRow) continue;
    const header = [...firstRow.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) =>
      stripTags(c[1]).toLowerCase()
    );
    // Locate columns by name rather than fixed position. Header cells often carry
    // sort affordances like "model↕"; match by substring / word boundaries so layout
    // variations (such as the removal of "tok/s" or column reordering) don't break.
    const model = header.findIndex((c) => c.includes("model"));
    const context = header.findIndex((c) => c.includes("context"));
    const input = header.findIndex((c) => /\binput\b/.test(c));
    const output = header.findIndex((c) => /\boutput\b/.test(c));
    const cacheRead = header.findIndex((c) => c.includes("cache read"));
    const cacheWrite = header.findIndex((c) => c.includes("cache write"));

    if (model !== -1 && context !== -1 && input !== -1 && output !== -1 && cacheRead !== -1 && cacheWrite !== -1) {
      chosen = table;
      colMap = {
        model,
        context,
        input,
        output,
        cacheRead,
        cacheWrite,
        intelligence: header.findIndex((c) => c.includes("intelligence")),
        caps: header.findIndex((c) => c.includes("caps") || c.includes("capabilities")),
      };
      break;
    }
  }
  if (!chosen || !colMap) {
    throw new EnrichmentError("Command Code enrichment: models table not found on page (layout may have changed)");
  }

  const entries = new Map();
  const rows = [...chosen.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((r) => r[0]);
  const maxRequired = Math.max(
    colMap.model,
    colMap.context,
    colMap.input,
    colMap.output,
    colMap.cacheRead,
    colMap.cacheWrite
  );
  for (const row of rows.slice(1)) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]);
    if (cells.length <= maxRequired) continue;
    const nameCell = cells[colMap.model];
    // The name cell holds the model link plus ancillary badges/notes
    // ("Free", "Off-peak shown …", deal markers). The link text is the
    // stable display name: stripping the whole cell would bake the badge
    // into the match key ("DeepSeek V4.1 FlashOff-peak shown …") and
    // every badged model — often newly released ones — would silently
    // miss enrichment and ship reasoning: false.
    const linkText = nameCell.match(/<a[^>]*>([\s\S]*?)<\/a>/)?.[1] ?? "";
    const name = stripTags(linkText) || stripTags(nameCell);
    if (!name) continue;
    // The /models/<slug> href is a stable machine key: no vendor prefix,
    // no "(latest)"/"(exp)" display qualifiers. Index it as an alias so
    // vendor-prefixed catalog ids ("deepseek/deepseek-v4-1-flash") match
    // even when the display name drifts from the catalog id.
    const slug = nameCell.match(/href="\/models\/([^"#?]+)/)?.[1]?.trim();
    // Capabilities live in an aria-label inside the row: "Capabilities: Text input, Vision, Reasoning".
    // Fall back to checking the caps cell directly if the aria-label pattern ever drifts.
    const capsLabel =
      row.match(/aria-label="Capabilities:\s*([^"]+)"/i)?.[1] ??
      (colMap.caps >= 0 ? cells[colMap.caps] : "") ??
      "";
    const caps = stripTags(capsLabel).toLowerCase();
    const entry = {
      name,
      ...(slug ? { slug } : {}),
      context: parseContext(cells[colMap.context]),
      intelligence: colMap.intelligence >= 0 ? stripTags(cells[colMap.intelligence] ?? "") : "",
      input: parsePrice(cells[colMap.input]),
      output: parsePrice(cells[colMap.output]),
      cacheRead: parsePrice(cells[colMap.cacheRead]),
      cacheWrite: parsePrice(cells[colMap.cacheWrite]),
      vision: /vision/.test(caps),
      reasoning: /reasoning/.test(caps),
    };
    entries.set(normalizeName(name), entry);
    // Alias the slug key (e.g. "deepseek-v4-1-flash"). normalizeName
    // already collapses ./-/_ separators, so "v4.1" and "v4-1" compare
    // equal; the guard only skips exact duplicates and collisions (first
    // row wins, same as display-name keys).
    if (slug) {
      const slugKey = normalizeName(slug);
      if (slugKey && !entries.has(slugKey)) entries.set(slugKey, entry);
    }
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
    // Rebuild both lookup keys (display name + /models slug alias).
    // Pre-slug caches have no `slug` field; the guard keeps them loading.
    const entries = new Map();
    for (const e of data.entries) {
      if (!e || typeof e.name !== "string" || !e.name) continue;
      const nameKey = normalizeName(e.name);
      if (!entries.has(nameKey)) entries.set(nameKey, e);
      if (typeof e.slug === "string" && e.slug) {
        const slugKey = normalizeName(e.slug);
        if (slugKey && !entries.has(slugKey)) entries.set(slugKey, e);
      }
    }
    return { entries, fetchedAt: data.fetchedAt, stale: now - data.fetchedAt > ttlMs };
  } catch {
    return null;
  }
}

/** Persist enrichment entries; failures are silently non-fatal. */
export function saveEnrichmentCache(entries, { cachePath = defaultCachePath(), now = Date.now(), source } = {}) {
  try {
    mkdirSync(join(cachePath, ".."), { recursive: true });
    // The map holds alias keys (display name + /models slug) pointing at
    // the same entry object; dedupe by identity so the cache stores each
    // model once. loadEnrichmentCache() rebuilds the aliases from entry.slug.
    const unique = [...new Set(entries.values())];
    writeFileSync(
      cachePath,
      JSON.stringify({ fetchedAt: now, source: source ?? ENRICHMENT_URL, entries: unique }, null, 2)
    );
  } catch {
    // Cache write failure must never break provider registration.
  }
}

/**
 * Merge enrichment metadata into normalized /models catalog entries (returning
 * new objects — input is not mutated). Match keys, in order: normalized
 * display name, normalized id, normalized id suffix after the vendor prefix
 * ("deepseek/deepseek-v4-1-flash" \u2192 "deepseek-v4-1-flash", matching the
 * table's /models/<slug> alias). All exact equality on the canonical form —
 * no fuzzy matching, so distinct variants (Flash vs Flash Fast vs Flash
 * Vision) never cross-match. Authoritative /models fields are never
 * overwritten; the page only fills gaps and pricing/capabilities.
 */
export function enrichCatalog(models, entries) {
  if (!entries) return models;
  return models.map((model) => {
    const id = String(model.id ?? "");
    const suffix = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : "";
    const hit =
      entries.get(normalizeName(model.name ?? model.id)) ??
      entries.get(normalizeName(model.id)) ??
      (suffix ? entries.get(normalizeName(suffix)) : undefined);
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
