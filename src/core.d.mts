/**
 * Type declarations for core.mjs.
 *
 * The runtime module is plain ES module JavaScript so it can be loaded by
 * Pi's jiti runtime AND tested directly with `node --test` without any
 * compile step. These declarations give the .ts entrypoint accurate types
 * for everything it imports.
 */

export interface ModelOverrideEntry {
  /** Positive integer maxTokens, or undefined when not set. */
  maxTokens?: number;
  /** Positive integer contextWindow, or undefined when not set. */
  contextWindow?: number;
}

/** A normalized entry from Command Code's /models endpoint. */
export interface CatalogEntry {
  id: string;
  name?: string;
  ownedBy?: string;
  contextLength?: number;
  maxTokens?: number;
  apiType?: string;
  // Populated by enrichCatalog():
  pricing?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  vision?: boolean;
  reasoning?: boolean;
}

/** Wire-protocol bucket assigned by classifyWire(). */
export type WireKind = "anthropic" | "openai";

/** Pi-side model definition produced by toPiModel(). */
export interface PiModelDefinition {
  id: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: { xhigh?: string };
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export const PROVIDER_ROOT: string;
export const OPENAI_BASE_URL: string;
export const ANTHROPIC_BASE_URL: string;
export const DISCOVERY_TIMEOUT_MS: number;
export const DEFAULT_CONTEXT_WINDOW: number;
export const DEFAULT_MAX_TOKENS: number;
export const DEFAULT_MAX_TOKENS_REASONING: number;

export class DiscoveryError extends Error {}

export function resolveApiKey(options?: { env?: Record<string, string | undefined>; authPath?: string }): string | undefined;

export function defaultAuthPath(options?: { env?: Record<string, string | undefined> }): string;

export function getDefaultMaxTokens(options?: { env?: Record<string, string | undefined>; reasoning?: boolean }): number;

export function defaultOverridesPath(options?: { env?: Record<string, string | undefined> }): string;

export function loadModelOverrides(options?: {
  path?: string;
  fsImpl?: { readFileSync: (path: string, encoding: string) => string };
}): Map<string, ModelOverrideEntry>;

export function readStoredApiKey(providerId: string, authPath?: string): string | undefined;

export function fetchCatalog(options: {
  apiKey: string | undefined;
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<CatalogEntry[]>;

export function parseCatalog(payload: unknown): CatalogEntry[];

export function classifyWire(model: Pick<CatalogEntry, "id" | "ownedBy" | "apiType">): WireKind;

export function splitByWire(models: CatalogEntry[]): { openaiModels: CatalogEntry[]; anthropicModels: CatalogEntry[] };

/** Best-effort Claude-family extended-thinking capability, or undefined for non-Claude models. */
export function inferClaudeThinking(model: Pick<CatalogEntry, "id">):
  | { reasoning: true; thinkingLevelMap?: { xhigh?: string } }
  | undefined;

export function toPiModel(
  model: CatalogEntry,
  overrides?: Map<string, ModelOverrideEntry>,
  defaultMaxTokens?: number
): PiModelDefinition;

export function toPiModels(
  models: CatalogEntry[],
  overrides?: Map<string, ModelOverrideEntry>,
  defaultMaxTokens?: number
): PiModelDefinition[];