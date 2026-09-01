/**
 * Augment `@earendil-works/pi-coding-agent`'s `ExtensionAPI` with the
 * provider registration methods that exist at runtime but are missing
 * from the public type declarations. This file is imported (via
 * `import type` side-effect) from `src/index.ts` so its declarations
 * take effect at type-check time without emitting any runtime code.
 *
 * We add:
 *   - `registerProvider(provider: RuntimeProvider)` — full Provider object
 *   - `registerProvider(name: string, config: ProviderConfig)` — declarative config
 *   - `unregisterProvider(name: string)`
 *
 * The runtime `Provider` object is not exported as a TS type from
 * `@earendil-works/pi-ai` (only its name-union is). We declare the
 * structural shape here so the augmentation has a real type to reference.
 */

import type { ProviderConfig } from "@earendil-works/pi-coding-agent";

/**
 * Runtime Provider object accepted by `registerProvider`. The shape
 * mirrors `@earendil-works/pi-ai`'s runtime object; we declare it locally
 * because the upstream type isn't exported (only the name-string union is).
 */
export interface RuntimeProvider {
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string>;
  /** Wire-protocol streamers; Pi uses these when no models.json overlay exists. */
  stream?: unknown;
  streamSimple?: unknown;
  auth?: {
    apiKey?: {
      name: string;
      login: (interaction: {
        prompt: (opts: {
          type: "text" | "secret" | "select";
          message: string;
          placeholder?: string;
          options?: Array<{ id: string; label: string }>;
        }) => Promise<string>;
        signal?: AbortSignal;
      }) => Promise<{ type: "api_key"; key: string }>;
      check: (args: { ctx: unknown; credential?: { type: "api_key"; key: string } }) => Promise<{ type: "api_key"; source: string } | undefined>;
      resolve: (args: { ctx: unknown; credential?: { type: "api_key"; key: string } }) => Promise<{ auth: { apiKey: string }; source: string } | undefined>;
    };
  };
  getModels?: () => unknown[];
  refreshModels?: (context: {
    allowNetwork?: boolean;
    credential?: { type: "api_key"; key: string };
    publish: (opts: { update?: () => void; persist?: unknown }) => Promise<boolean>;
    stored?: { models?: unknown[] } | null;
    signal: AbortSignal;
  }) => Promise<void>;
}

declare module "@earendil-works/pi-coding-agent" {
  interface ExtensionAPI {
    registerProvider(provider: RuntimeProvider): void;
    registerProvider(name: string, config: ProviderConfig): void;
    unregisterProvider(name: string): void;
  }
}

export {};
