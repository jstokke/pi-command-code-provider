# Changelog

Notes on what changed. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.3.0] — 2026-09-10

First release published to npm. Everything that was under `[Unreleased]` shipped
here, because `0.3.0` had never been published as a package.

### Added

- Native Pi provider `src/native-provider.mjs` with `createCommandCodeProvider()`
  — a pure module that builds the runtime `Provider` object, with HTTP, the
  auth.json reader and the enrichment fetcher injected for testability.
- `src/native-provider.d.mts` and `src/pi-extension-augment.d.ts`, typing the
  native provider and augmenting `ExtensionAPI.registerProvider` with the
  `RuntimeProvider` overload.
- `pi` package manifest (`pi.extensions: ["./src/index.ts"]`) and the
  `pi-package` keyword, so the extension installs with one command
  (`pi install npm:pi-command-code-provider`).
- `npm run check:pack` (`scripts/check-pack-contents.mjs`), which asserts what
  `npm publish` would upload. It runs in CI, so a change to `files` fails the
  build instead of shipping something unintended.
- `npm run release -- patch|minor|major|X.Y.Z` (`scripts/release.mjs`), which
  bumps, tags and publishes. It verifies the git state, that the tag and the npm
  version are both unused, and that this file has a section for the version
  before touching anything; runs the test, typecheck and pack checks; rehearses
  the publish; and publishes *before* pushing, rolling the local commit and tag
  back if the registry rejects the tarball. `--dry-run` runs every check and
  changes nothing.
- `prepublishOnly` re-runs the test, typecheck and pack checks on any
  `npm publish`, so a manual publish cannot skip them. It does not run on
  install.
- `src/declarations.test.mjs`, which asserts that every value export declared in
  the hand-written `.d.mts` files exists at runtime and that every runtime export
  is declared.
- `SECURITY.md`, a pull request template, and Dependabot configuration.

### Changed

- Switched from declarative `pi.registerProvider(name, config)` to
  native `pi.registerProvider(provider)` (previously
  `pi.registerNativeProvider`). The extension now hooks into
  Pi's built-in `/login` slash command for API key entry — masked
  secret input, `auth.json` persistence, status display in the
  selector, and `/logout` support all come from Pi itself. Manual
  auth.json edits and the `COMMAND_CODE_API_KEY` env var still work
  as fallbacks.
- `@earendil-works/pi-ai` is now declared alongside `@earendil-works/pi-coding-agent`
  as an optional peer dependency with a `"*"` range, per Pi's package docs. It is
  imported at runtime (`pi-ai/compat`) but was previously only a devDependency.
- The peer range moved from `^0.84.4` to `"*"`. On npm's semver rules a `0.x`
  caret pins the minor, so `^0.84.4` resolved only to `0.84.4` and excluded
  current Pi — a plain `npm install` would have pulled a second, older copy.
  The extension is verified against Pi 0.85.1.
- Dev tooling moved to `typescript@^7.0.2` and `@types/node@^20.19.43`. The
  Node types are deliberately pinned to the `engines` floor (`>=20`) so the type
  checker cannot accept APIs that do not exist on the oldest supported Node.
- A committed `package-lock.json`, so CI and contributors install reproducibly
  via `npm ci`.
- Packaging: added a `files` allowlist (test files, `.github/`, `tsconfig.json`
  and contributor docs no longer ship — 21 files / 143 kB unpacked became 13
  files / 82 kB), plus `publishConfig.access`, an `author` field, and the MIT
  copyright holder.
- Root `README.md` overhauled with a 3-step quickstart (`pi install`,
  `/login command-code`, `/model`), npm as the primary install path, and
  documentation for configuration, protocol routing, extended thinking,
  overrides, and troubleshooting.
- `src/README.md` and `CONTRIBUTING.md` updated to lead with `pi install`, and
  `CONTRIBUTING.md` now states what `npm run typecheck` does and does not cover,
  with the measured numbers.
- CI installs with `npm ci` under `permissions: contents: read`, with
  cancel-in-progress concurrency, npm caching, a pack-contents check, and
  `actions/checkout@v7` / `actions/setup-node@v7`.

### Fixed

- Published models now carry `provider`, `api`, and `baseUrl`
  (Pi's model runtime drops models without a `provider` field from
  `/model`, and dispatches requests by wire `api`). Previously the
  catalog loaded but never appeared in `/model` and any request
  would fail with "No API provider registered".
- `refreshModels()` now restores the persisted catalog from
  Pi's models store in the offline phase, matching pi's own
  remote-catalog and llama.cpp providers. `/model`, `--list-models`,
  and offline startups now show the catalog immediately instead of
  staying empty until a successful network fetch.
- The startup warning is no longer printed when a valid
  credential already exists in auth.json; it now fires only when
  neither the env var nor the stored key is present.
- Models published by the OpenAI provider now stamp the
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
