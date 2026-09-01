/**
 * Type declarations for native-provider.mjs.
 *
 * The runtime module is plain ES module JavaScript so it can be loaded by
 * Pi's jiti runtime AND tested directly with `node --test` without any
 * compile step. These declarations give the .ts entrypoint accurate types
 * for everything it imports.
 */

import type { CatalogEntry, ModelOverrideEntry } from "./core.d.mjs";
import type { EnrichmentEntry } from "./enrich.d.mts";

/** Minimal shape of the Interaction object Pi passes to `login()`. */
export interface AuthInteraction {
  prompt: (opts: {
    type: "text" | "secret" | "select";
    message: string;
    placeholder?: string;
    options?: Array<{ id: string; label: string }>;
  }) => Promise<string>;
  signal?: AbortSignal;
}

/** Pi passes one of these to `check()` / `resolve()`. */
export interface ApiKeyCredential {
  type: "api_key";
  key: string;
}

/** Context Pi provides to auth callbacks. Use `unknown` at the API surface
 * so the runtime `Provider` shape is structurally compatible with the
 * augmentation in `pi-extension-augment.d.ts`. */
export type AuthContext = unknown;

/** Context Pi provides to `refreshModels()`. */
export interface RefreshModelsContext {
  allowNetwork?: boolean;
  credential?: ApiKeyCredential;
  /**
   * Publish an update to Pi's runtime. Returns false when the update was
   * cancelled (e.g. signal aborted) — caller should drop the change.
   */
  publish: (opts: { update?: () => void; persist?: unknown }) => Promise<boolean>;
  /** Previously persisted models, if any. */
  stored?: { models?: unknown[] } | null;
  signal: AbortSignal;
}

/** Per-provider options for `createCommandCodeProvider`. */
export interface CreateProviderOptions {
  id: string;
  name: string;
  baseUrl: string;
  api: "openai-completions" | "anthropic-messages";
  /** Override for tests. Defaults to core.mjs's fetchCatalog. */
  fetchCatalog?: (options: {
    apiKey: string | undefined;
    url?: string;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
  }) => Promise<CatalogEntry[]>;
  fetchEnrichmentFn?: (options?: { url?: string; timeoutMs?: number; fetchImpl?: typeof fetch }) => Promise<Map<string, EnrichmentEntry>>;
  loadEnrichmentCacheFn?: () => { entries: Map<string, EnrichmentEntry>; fetchedAt: number; stale: boolean } | null;
  saveEnrichmentCacheFn?: (
    entries: Map<string, EnrichmentEntry>,
    options?: { cachePath?: string; now?: number; source?: string }
  ) => void;
  loadModelOverridesFn?: () => Map<string, ModelOverrideEntry>;
  readStoredApiKeyFn?: (providerId: string, authPath?: string) => string | undefined;
  extraHeaders?: Record<string, string>;
}

/**
 * The runtime `Provider` shape pi-coding-agent accepts via
 * `registerNativeProvider`. Fields used here are only what Command Code needs;
 * Pi ignores anything else.
 */
export interface NativeProvider {
  id: string;
  name: string;
  baseUrl: string;
  headers?: Record<string, string>;
  auth: {
    apiKey: {
      name: string;
      login: (interaction: AuthInteraction) => Promise<ApiKeyCredential>;
      check: (args: { ctx: AuthContext; credential?: ApiKeyCredential }) => Promise<{ type: "api_key"; source: string } | undefined>;
      resolve: (args: { ctx: AuthContext; credential?: ApiKeyCredential }) => Promise<{ auth: { apiKey: string }; source: string } | undefined>;
    };
  };
  getModels: () => unknown[];
  refreshModels: (context: RefreshModelsContext) => Promise<void>;
}

export function createCommandCodeProvider(options: CreateProviderOptions): NativeProvider;