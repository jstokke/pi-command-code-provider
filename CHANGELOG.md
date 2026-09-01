# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- GitHub Actions CI workflow (Node 20/22/24, test + typecheck).
- `CONTRIBUTING.md` with development setup, test, and release guidance.

## [0.2.0] - 2025-XX-XX

### Fixed
- Claude-family models now ship with `reasoning: true` via the new
  `inferClaudeThinking()` heuristic. Previously every Claude model silently
  shipped `reasoning: false` because the GOAT enrichment page does not cover
  Claude — defeating the 128k maxTokens bump this extension otherwise
  applies.
- Adaptive-thinking Claude models (Opus 4.6/4.7, Sonnet 4.6+) now expose
  the `xhigh` (and `max` on Opus 4.6) thinking level in Pi's UI via a
  per-model `thinkingLevelMap`. Without this entry Pi's
  `getSupportedThinkingLevels` filters `xhigh` out entirely.

### Added
- `getEnrichmentUrl()` + `COMMAND_CODE_ENRICHMENT_URL` env override for
  resilience against docs-page restructuring (mirror, local proxy, etc.).
- Startup success log line `Command Code: registered N model(s) (M openai,
  K anthropic)` so silent regressions (empty catalog, misclassification)
  are visible without enabling debug logs.
- Type declarations (`core.d.mts`, `enrich.d.mts`) and `tsconfig.json`
  for `tsc --noEmit` to type-check the entrypoint against the runtime
  modules.

### Changed
- README rewritten for OSS audience: corrected the misleading
  "no HTML scraping" claim (the enrichment layer does scrape the GOAT page);
  documented the new Claude extended-thinking behavior and the
  `COMMAND_CODE_ENRICHMENT_URL` / `COMMAND_CODE_NO_ENRICHMENT` env vars;
  updated test count and troubleshooting.
- `enrichCatalog` doc comment corrected — the function returns new objects
  rather than mutating input.

## [0.1.0] - 2025-XX-XX

### Added
- Initial release. Fetches the live catalog from
  `GET https://api.commandcode.ai/provider/v1/models` at Pi startup and
  registers two providers:
  - `command-code` (OpenAI Chat Completions wire)
  - `command-code-anthropic` (Anthropic Messages wire)
- Auth resolution: `COMMAND_CODE_API_KEY` env var → `auth.json` credential.
- Concurrent enrichment scrape of the GOAT plan page with a 24h TTL cache.
- Per-model `maxTokens` / `contextWindow` overrides via
  `~/.pi/agent/command-code-model-overrides.json` (raise-only — the
  `/models` cap is the floor).
- `COMMAND_CODE_DEFAULT_MAX_TOKENS` env var as a uniform global default.
- Reasoning-aware maxTokens default (128k for reasoning models, 64k
  otherwise) to avoid the upstream `Response was truncated` error.
- `CMD_ZDR=1` opt-in to send `x-cmd-zdr: 1` on every request.
- 73 unit tests with fully mocked HTTP, secret-hygiene invariants,
  TTL-cache, override plumbing, and classification.

[Unreleased]: https://github.com/your-org/pi-command-code-provider/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/your-org/pi-command-code-provider/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/your-org/pi-command-code-provider/releases/tag/v0.1.0