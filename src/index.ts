/**
 * Command Code — dynamic custom provider for Pi.
 *
 * Registers two native providers backed by the same Command Code account:
 *
 *   command-code            → OpenAI Chat Completions wire (openai-completions)
 *   command-code-anthropic  → Anthropic Messages wire (anthropic-messages)
 *
 * Auth is handled by Pi's `/login` flow. The extension exposes an
 * `auth.apiKey` block on each provider; Pi prompts with a masked secret
 * input, validates the key by hitting `/models`, persists to `auth.json`,
 * and surfaces the credential's source ("stored credential" or
 * "COMMAND_CODE_API_KEY") in the selector. The `COMMAND_CODE_API_KEY` env
 * var is still honored as a fallback for headless setups.
 *
 * The catalog is fetched lazily — Pi calls `refreshModels()` on first model
 * use and on `/model` refresh, never at extension startup. The /models call
 * is bounded 8s; the GOAT enrichment page scrape runs concurrently with a
 * 24h TTL cache.
 *
 * Per-model maxTokens / contextWindow overrides live in
 * ~/.pi/agent/command-code-model-overrides.json (see core.mjs and README).
 *
 * ZDR: set CMD_ZDR=1 to send the "x-cmd-zdr: 1" header on every request.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { ANTHROPIC_BASE_URL, OPENAI_BASE_URL, readStoredApiKey } from "./core.mjs";
import { createCommandCodeProvider } from "./native-provider.mjs";

export default async function (pi: ExtensionAPI) {
  const extraHeaders = process.env.CMD_ZDR === "1" ? { "x-cmd-zdr": "1" } : undefined;

  // Two providers, same credential, different wire protocols. Both expose
  // auth.apiKey so /login shows both in the selector; logging into either
  // authenticates both via the shared "command-code" auth.json key.
  const commandCode = createCommandCodeProvider({
    id: "command-code",
    name: "Command Code",
    baseUrl: OPENAI_BASE_URL,
    api: "openai-completions",
    extraHeaders,
  });

  const commandCodeAnthropic = createCommandCodeProvider({
    id: "command-code-anthropic",
    name: "Command Code (Anthropic)",
    baseUrl: ANTHROPIC_BASE_URL,
    api: "anthropic-messages",
    extraHeaders,
  });

  pi.registerProvider(commandCode);
  pi.registerProvider(commandCodeAnthropic);

  // Best-effort startup hint. The /login selector is the primary setup
  // path now; we log here so first-time users see *something* instead of
  // an empty `/model` picker. The actual credential check is cheap
  // (process.env + one auth.json read). Only warn when BOTH sources are
  // missing — a stored auth.json credential is a perfectly valid setup
  // and must not produce a scary warning on every launch.
  const hasEnv = (process.env.COMMAND_CODE_API_KEY || "").trim() !== "";
  const hasStored = readStoredApiKey("command-code") !== undefined;
  if (!hasEnv && !hasStored) {
    console.error(
      "Command Code: no API key found. Run `/login command-code` in Pi (the key is saved to ~/.pi/agent/auth.json), or set the COMMAND_CODE_API_KEY env var before launching."
    );
  }
}
