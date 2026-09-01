/**
 * Unit tests for the enrichment layer (GOAT page scraping + TTL cache).
 * Run: node --test
 * All HTTP and filesystem paths are mocked/isolated; the live site is never contacted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENRICHMENT_TTL_MS,
  ENRICHMENT_URL,
  EnrichmentError,
  enrichCatalog,
  fetchEnrichment,
  getEnrichmentUrl,
  loadEnrichmentCache,
  normalizeName,
  parseContext,
  parseEnrichmentHtml,
  parsePrice,
  saveEnrichmentCache,
} from "./enrich.mjs";

function cell(text) {
  return `<td data-slot="table-cell"><span class="block leading-5">${text}</span></td>`;
}

function capCell(label) {
  return `<td><button type="button" aria-label="Capabilities: ${label}"><svg></svg></button></td>`;
}

function tableHtml(rows, { withSortMarkers = false } = {}) {
  const labels = ["Model", "Context", "Intelligence", "Tok/s", "Input", "Output", "Cache read", "Cache write", "Caps"];
  const header = (withSortMarkers ? labels.map((l) => `${l}↕`) : labels)
    .map((h) => `<th>${h}</th>`)
    .join("");
  const body = rows
    .map(
      ([name, context, intel, toks, input, output, cacheRead, cacheWrite, caps]) =>
        `<tr><td><a href="/models/x">${name}</a></td>${cell(context)}${cell(intel)}${cell(toks)}${cell(input)}${cell(output)}${cell(cacheRead)}${cell(cacheWrite)}${capCell(caps)}</tr>`
    )
    .join("");
  return `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

function samplePage() {
  return `<html><body>
  <table><tr><th>other</th></tr><tr><td>noise</td></tr></table>
  ${tableHtml([
    ["GLM-5.3 Flash", "1M", "57.5", "42", "$0.15", "$0.50", "$0.03", "—", "Text input, Vision, Reasoning"],
    ["DeepSeek V4 Pro (latest)", "1M", "69.1", "129", "$0.22", "$0.99", "$0.022", "—", "Text input, Reasoning"],
    ["MiniMax M2.7", "197K", "38.9", "35", "Free", "Free", "Free", "—", "Text input"],
    ["GPT-5.6 Sol", "1.05M", "51.8", "90", "$5.00", "$30.00", "$0.50", "$6.25", "Text input, Vision, Reasoning"],
    ["Some Model", "262144", "40", "—", "$1", "$2", "$0.10", "-", "Text input"],
  ])}
  </body></html>`;
}

const pricing = { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 };

// ---------- enrichment URL resolution ----------

test("getEnrichmentUrl returns the default when the env var is unset or blank", () => {
  assert.equal(getEnrichmentUrl({ env: {} }), ENRICHMENT_URL);
  assert.equal(getEnrichmentUrl({ env: { COMMAND_CODE_ENRICHMENT_URL: "" } }), ENRICHMENT_URL);
  assert.equal(getEnrichmentUrl({ env: { COMMAND_CODE_ENRICHMENT_URL: "   " } }), ENRICHMENT_URL);
});

test("getEnrichmentUrl honors a non-empty env override and trims whitespace", () => {
  assert.equal(getEnrichmentUrl({ env: { COMMAND_CODE_ENRICHMENT_URL: "https://mirror.example.com/goat" } }), "https://mirror.example.com/goat");
  assert.equal(getEnrichmentUrl({ env: { COMMAND_CODE_ENRICHMENT_URL: "  https://mirror.example.com/goat  " } }), "https://mirror.example.com/goat");
});

test("fetchEnrichment hits the overridden URL when one is provided", async () => {
  let seen;
  await fetchEnrichment({
    url: "https://mirror.example.com/goat",
    fetchImpl: async (url, init) => {
      seen = { url, headers: init.headers };
      return { ok: true, status: 200, text: async () => samplePage() };
    },
  });
  assert.equal(seen.url, "https://mirror.example.com/goat");
});

// ---------- price/context parsing ----------

test("parsePrice handles dollars, Free, dashes and garbage", () => {
  assert.equal(parsePrice("$0.15"), 0.15);
  assert.equal(parsePrice("$5.00"), 5);
  assert.equal(parsePrice("Free"), 0);
  assert.equal(parsePrice("—"), 0); // no priced tier (e.g. cache writes unsupported)
  assert.equal(parsePrice("-"), 0);
  assert.equal(parsePrice(""), undefined);
  assert.equal(parsePrice("<span>$1.2</span>"), 1.2);
  assert.equal(parsePrice("n/a"), undefined);
});

test("parseContext handles K/M suffixes, thousands separators and plain numbers", () => {
  assert.equal(parseContext("1M"), 1000000);
  assert.equal(parseContext("256K"), 256000);
  assert.equal(parseContext("1.05M"), 1050000);
  assert.equal(parseContext("1,048,576"), 1048576);
  assert.equal(parseContext("262144"), 262144);
  assert.equal(parseContext("—"), undefined);
});

// ---------- page parsing ----------

test("parses the GOAT models table with pricing and capabilities", () => {
  const entries = parseEnrichmentHtml(samplePage());
  assert.equal(entries.size, 5);
  const glm = entries.get(normalizeName("GLM-5.3 Flash"));
  assert.equal(glm.input, 0.15);
  assert.equal(glm.output, 0.5);
  assert.equal(glm.cacheRead, 0.03);
  assert.equal(glm.cacheWrite, 0); // "—" maps to 0 after enrichment merge; raw undefined here
  assert.equal(glm.vision, true);
  assert.equal(glm.reasoning, true);
  assert.equal(glm.context, 1000000);
  const minimax = entries.get(normalizeName("MiniMax M2.7"));
  assert.equal(minimax.input, 0);
  assert.equal(minimax.vision, false);
  assert.equal(minimax.reasoning, false);
  const gpt = entries.get(normalizeName("GPT-5.6 Sol"));
  assert.equal(gpt.cacheWrite, 6.25);
  assert.equal(gpt.vision, true);
});

test("table is selected by header signature, not position; noise tables ignored", () => {
  // parseEnrichmentHtml already ignores the noise table in samplePage(); assert row count proves it
  const entries = parseEnrichmentHtml(samplePage());
  assert.equal(entries.size, 5);
  assert.throws(() => parseEnrichmentHtml("<table><tr><th>a</th><th>b</th></tr></table>"), EnrichmentError);
});

test("real-world sort arrows on headers (e.g. 'Model↕') do not break selection", () => {
  const html =
    `<table><tr><th>other</th></tr><tr><td>noise</td></tr></table>` +
    tableHtml([["GLM-5.3 Flash", "1M", "57.5", "42", "$0.15", "$0.50", "$0.03", "—", "Text input, Vision, Reasoning"]], { withSortMarkers: true });
  const entries = parseEnrichmentHtml(html);
  assert.equal(entries.size, 1);
  assert.equal(entries.get(normalizeName("GLM-5.3 Flash")).input, 0.15);
});

test("malformed pages produce useful errors", () => {
  assert.throws(() => parseEnrichmentHtml(""), EnrichmentError);
  assert.throws(() => parseEnrichmentHtml("<html>no tables</html>"), /models table not found/);
  assert.throws(
    () => parseEnrichmentHtml("<table><tr><th>Model</th><th>Context</th></tr><tr><td>x</td></tr></table>"),
    /models table not found/
  );
  assert.throws(
    () =>
      parseEnrichmentHtml(
        tableHtml([]).replace("<tbody></tbody>", "<tbody></tbody>") // header-only table
      ),
    /contains no rows/
  );
});

// ---------- catalog merging ----------

test("enrichCatalog fills pricing and capabilities by display name", () => {
  const entries = parseEnrichmentHtml(samplePage());
  const catalog = [
    { id: "z-ai/glm-5.3-flash", name: "GLM-5.3 Flash", contextLength: 1048576 },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek V4 Pro (latest)", contextLength: 1000000 },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 }, // not on GOAT page
  ];
  const enriched = enrichCatalog(catalog, entries);
  const glm = enriched[0];
  assert.deepEqual(glm.pricing, pricing);
  assert.equal(glm.vision, true);
  assert.equal(glm.reasoning, true);
  // /models context stays authoritative (not overwritten by page "1M")
  assert.equal(glm.contextLength, 1048576);
  const ds = enriched[1];
  assert.equal(ds.pricing.input, 0.22);
  assert.equal(ds.reasoning, true);
  assert.equal(ds.vision, false);
  const claude = enriched[2];
  assert.equal(claude.pricing, undefined, "unmatched models keep conservative defaults");
  assert.equal(claude.vision, undefined);
});

test("enrichCatalog falls back to matching by id when name lookup misses", () => {
  const entries = new Map([[normalizeName("z-ai/glm-5.3-flash"), { name: "z-ai/glm-5.3-flash", input: 0.1, output: 0.2, cacheRead: 0.01, cacheWrite: 0, vision: false, reasoning: false }]]);
  const enriched = enrichCatalog([{ id: "z-ai/glm-5.3-flash", name: "Odd Display Name" }], entries);
  assert.equal(enriched[0].pricing.input, 0.1);
});

test("enrichCatalog with no entries is a no-op", () => {
  const catalog = [{ id: "x", name: "X" }];
  assert.deepEqual(enrichCatalog(catalog, null), catalog);
});

test("toPiModel consumes enriched metadata; unenriched models keep defaults", async () => {
  const { toPiModel } = await import("./core.mjs");
  const enriched = toPiModel({
    id: "z-ai/glm-5.3-flash",
    name: "GLM-5.3 Flash",
    contextLength: 1048576,
    pricing,
    vision: true,
    reasoning: true,
  });
  assert.deepEqual(enriched.cost, pricing);
  assert.equal(enriched.reasoning, true);
  assert.deepEqual(enriched.input, ["text", "image"]);

  // Claude family is now flagged as reasoning by the Claude heuristic
  // (the GOAT page does not cover Claude), but pricing stays at the
  // conservative defaults because no enrichment entry matched.
  const plain = toPiModel({ id: "claude-sonnet-5", name: "Claude Sonnet 5", contextLength: 1000000 });
  assert.deepEqual(plain.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(plain.reasoning, true);
  assert.deepEqual(plain.input, ["text"]);
});

// ---------- fetching ----------

test("fetchEnrichment parses a successful HTML response", async () => {
  const entries = await fetchEnrichment({ fetchImpl: async () => ({ ok: true, status: 200, text: async () => samplePage() }) });
  assert.equal(entries.size, 5);
});

test("fetchEnrichment HTTP errors and timeouts are bounded and reported", async () => {
  await assert.rejects(
    fetchEnrichment({ fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }) }),
    (e) => e instanceof EnrichmentError && /HTTP 503/.test(e.message)
  );
  const start = Date.now();
  await assert.rejects(
    fetchEnrichment({
      timeoutMs: 80,
      fetchImpl: (_url, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted")))),
    }),
    (e) => e instanceof EnrichmentError && /timed out after 80ms/.test(e.message)
  );
  assert.ok(Date.now() - start < ENRICHMENT_TTL_MS);
  await assert.rejects(
    fetchEnrichment({ fetchImpl: async () => { throw new Error("DNS fail"); } }),
    /DNS fail/
  );
});

test("fetchEnrichment never receives an API key", async () => {
  let seenInit;
  await fetchEnrichment({ fetchImpl: async (url, init) => { seenInit = { url, headers: init.headers }; return { ok: true, status: 200, text: async () => samplePage() }; } });
  const initJson = JSON.stringify(seenInit);
  assert.ok(!initJson.toLowerCase().includes("authorization"));
  assert.equal(seenInit.url, "https://commandcode.ai/docs/plans/goat");
});

// ---------- TTL cache ----------

test("cache round-trips and honors TTL staleness", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-enrich-"));
  const path = join(dir, "cache.json");
  const entries = parseEnrichmentHtml(samplePage());
  const now = 1_750_000_000_000;
  saveEnrichmentCache(entries, { cachePath: path, now });
  assert.ok(existsSync(path));

  const fresh = loadEnrichmentCache({ cachePath: path, now: now + 1000 });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.entries.size, 5);

  const stale = loadEnrichmentCache({ cachePath: path, now: now + ENRICHMENT_TTL_MS + 1000 });
  assert.equal(stale.stale, true);

  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.source, "https://commandcode.ai/docs/plans/goat");
  assert.ok(Array.isArray(raw.entries));
});

test("missing, corrupt, or wrong-shaped cache returns null instead of throwing", () => {
  assert.equal(loadEnrichmentCache({ cachePath: "/nonexistent/cache.json" }), null);
  const dir = mkdtempSync(join(tmpdir(), "cc-enrich-"));
  const path = join(dir, "cache.json");
  writeFileSync(path, "{corrupt");
  assert.equal(loadEnrichmentCache({ cachePath: path }), null);
  writeFileSync(path, JSON.stringify({ fetchedAt: "nope", entries: "nope" }));
  assert.equal(loadEnrichmentCache({ cachePath: path }), null);
});

test("saving to an unwritable path is non-fatal", () => {
  assert.doesNotThrow(() => saveEnrichmentCache(new Map(), { cachePath: "/root/definitely/not/writable.json" }));
});
