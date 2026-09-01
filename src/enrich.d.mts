/**
 * Type declarations for enrich.mjs.
 *
 * See core.d.mts for the rationale; same pattern applies.
 */

/** A single row from the GOAT plan table. */
export interface EnrichmentEntry {
  name: string;
  context?: number;
  intelligence: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  vision: boolean;
  reasoning: boolean;
}

export interface EnrichmentCache {
  entries: Map<string, EnrichmentEntry>;
  fetchedAt: number;
  stale: boolean;
}

export const ENRICHMENT_URL: string;
export const ENRICHMENT_TTL_MS: number;
export const ENRICHMENT_TIMEOUT_MS: number;

export class EnrichmentError extends Error {}

export function defaultCachePath(options?: { env?: Record<string, string | undefined> }): string;

export function getEnrichmentUrl(options?: { env?: Record<string, string | undefined> }): string;

export function fetchEnrichment(options?: {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<Map<string, EnrichmentEntry>>;

export function parseEnrichmentHtml(html: string): Map<string, EnrichmentEntry>;

export function parsePrice(text: string): number | undefined;

export function parseContext(text: string): number | undefined;

export function normalizeName(name: string): string;

export function loadEnrichmentCache(options?: {
  cachePath?: string;
  now?: number;
  ttlMs?: number;
}): EnrichmentCache | null;

export function saveEnrichmentCache(
  entries: Map<string, EnrichmentEntry>,
  options?: { cachePath?: string; now?: number; source?: string }
): void;

/**
 * Merge enrichment metadata into normalized /models catalog entries (returning
 * new objects — input is not mutated). Pass undefined entries to skip.
 */
export function enrichCatalog<T extends { id: string; name?: string }>(
  models: T[],
  entries: Map<string, EnrichmentEntry> | undefined | null
): (T & {
  pricing?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  vision?: boolean;
  reasoning?: boolean;
  contextLength?: number;
})[];