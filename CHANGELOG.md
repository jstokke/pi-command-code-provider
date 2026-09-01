# Changelog

Notes on what changed. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

- GitHub Actions CI on Node 20/22/24 (`npm run test:ci` + `npm run typecheck`).
- `CONTRIBUTING.md` with dev setup, test, and release notes.

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
- 73 unit tests, fully mocked HTTP, secret-hygiene invariants, TTL cache,
  override plumbing, classification.

[Unreleased]: https://github.com/jstokke/pi-command-code-provider/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/jstokke/pi-command-code-provider/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/jstokke/pi-command-code-provider/releases/tag/v0.1.0