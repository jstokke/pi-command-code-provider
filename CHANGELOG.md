# Changelog

Notes on what changed. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Added `pi` package manifest (`pi.extensions: ["./src/index.ts"]`) and `pi-package`
  keyword to `package.json`, enabling single-command installation via Pi's native
  package manager (`pi install git:github.com/jstokke/pi-command-code-provider`).

### Changed

- Completely overhauled root `README.md` to introduce a clear 3-step baby-step
  installation and setup guide (`pi install`, `/login command-code`, `/model`),
  along with comprehensive documentation for configuration, protocol routing,
  extended thinking, overrides, and troubleshooting.
- Updated `src/README.md` and `CONTRIBUTING.md` to recommend `pi install` as the
  primary setup path.

## [0.3.0]

### Changed

- Switched from declarative `pi.registerProvider(name, config)` to
  native `pi.registerProvider(provider)` (previously
  `pi.registerNativeProvider`). The extension now hooks into
  Pi's built-in `/login` slash command for API key entry — masked
  secret input, `auth.json` persistence, status display in the
  selector, and `/logout` support all come from Pi itself. Manual
  auth.json edits and the `COMMAND_CODE_API_KEY` env var still work
  as fallbacks.
- Fixed: published models now carry `provider`, `api`, and `baseUrl`
  (Pi's model runtime drops models without a `provider` field from
  `/model`, and dispatches requests by wire `api`). Previously the
  catalog loaded but never appeared in `/model` and any request
  would fail with "No API provider registered".
- Fixed: `refreshModels()` now restores the persisted catalog from
  Pi's models store in the offline phase, matching pi's own
  remote-catalog and llama.cpp providers. `/model`, `--list-models`,
  and offline startups now show the catalog immediately instead of
  staying empty until a successful network fetch.
- Fixed: the startup warning is no longer printed when a valid
  credential already exists in auth.json; it now fires only when
  neither the env var nor the stored key is present.
- Fixed: models published by the OpenAI provider now stamp the
  shared `stream`/`streamSimple` wire dispatch (pi-ai compat), so
  chat completion actually routes to the matching wire protocol.
- Extra request headers (e.g. the ZDR `x-cmd-zdr: 1` header) are
  now attached to the auth resolution so they reach every request.
- The catalog fetch moved out of extension startup and into Pi's
  `refreshModels(context)` callback. It runs lazily on first model
  use and on `/model` refresh, never at extension load. `/models` and
  the GOAT enrichment scrape still run concurrently, bounded 8s.
- The two providers now share the `command-code` auth.json credential
  (instead of writing to separate keys). Logging into either via
  `/login` authenticates both.

### Added

- New `src/native-provider.mjs` with `createCommandCodeProvider()` —
  a pure module that builds the runtime `Provider` object. All
  dependencies (HTTP, auth.json reader, enrichment fetcher) are
  injected for testability.
- New `src/native-provider.d.mts` and `src/pi-extension-augment.d.ts`
  to type the native provider and augment `ExtensionAPI.registerProvider`
  with the `RuntimeProvider` overload.
- `peerDependencies` declares `@earendil-works/pi-coding-agent`.

## [0.2.0]

### Fixed

- Claude models now ship with `reasoning: true` thanks to a new
  `inferClaudeThinking()` helper. Before this, every Claude model silently
  had `reasoning: false` (the GOAT enrichment page doesn't cover Claude),
  which meant Pi never enabled extended thinking on them — defeating the
  128k maxTokens bump this extension otherwise applies.
- Adaptive-thinking Claude models (Opus 4.6/4.7, Sonnet 4.6+) now expose
  the `xhigh` (and `max` on Opus 4.6) thinking level in Pi's picker via a
  per-model `thinkingLevelMap`. Without it, Pi's
  `getSupportedThinkingLevels` filters `xhigh` out entirely.

### Added

- `COMMAND_CODE_ENRICHMENT_URL` env override for resilience against the
  docs page restructuring (mirror, local proxy, etc.).
- Startup success log: `Command Code: registered N model(s) (M openai,
  K anthropic)`. Silent regressions (empty catalog, misclassification)
  are now visible without enabling debug logs.
- Type declarations (`core.d.mts`, `enrich.d.mts`) and `tsconfig.json`,
  so `tsc --noEmit` can type-check the entrypoint against the runtime
  modules.

### Changed

- `src/README.md` rewritten for clarity and a slightly less formal voice.
  Dropped the misleading "no HTML scraping" claim (the enrichment layer
  does scrape the GOAT page); documented the new
  `COMMAND_CODE_ENRICHMENT_URL` env var and the Claude extended-thinking
  behavior.
- `enrichCatalog` doc comment corrected — it returns new objects rather
  than mutating input.

## [0.1.0]

Initial release.

- Fetches `GET https://api.commandcode.ai/provider/v1/models` at startup
  (8s timeout, single attempt) and registers two providers:
  - `command-code` (OpenAI Chat Completions wire)
  - `command-code-anthropic` (Anthropic Messages wire)
- Auth: `COMMAND_CODE_API_KEY` env var, falling back to the
  `command-code` credential in `~/.pi/agent/auth.json`.
- Concurrent enrichment scrape of the GOAT plan page with a 24h TTL cache.
- Per-model `maxTokens` / `contextWindow` overrides via
  `~/.pi/agent/command-code-model-overrides.json` (raise-only — `/models`
  is the floor).
- `COMMAND_CODE_DEFAULT_MAX_TOKENS` env var for a uniform global default.
- Reasoning-aware maxTokens default (128k for reasoning, 64k otherwise) to
  avoid the upstream `Response was truncated` error.
- `CMD_ZDR=1` opt-in to send `x-cmd-zdr: 1` on every request.
- `COMMAND_CODE_NO_ENRICHMENT=1` to skip enrichment entirely.
- 101 unit tests, fully mocked HTTP, secret-hygiene invariants, TTL cache,
  override plumbing, classification.

[Unreleased]: https://github.com/jstokke/pi-command-code-provider/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/jstokke/pi-command-code-provider/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/jstokke/pi-command-code-provider/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jstokke/pi-command-code-provider/releases/tag/v0.1.0
