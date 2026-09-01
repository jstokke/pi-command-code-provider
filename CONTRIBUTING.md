# Contributing

Thanks for considering a contribution. This is a small, focused extension —
the surface area is intentionally narrow, and most changes touch one of
three files (`src/index.ts`, `src/core.mjs`, `src/enrich.mjs`) plus tests.

## Development setup

```bash
git clone <repo>
cd pi-command-code-provider
npm install
```

`npm install` pulls `@earendil-works/pi-coding-agent` and `@types/node` for
type-checking. The runtime modules (`core.mjs`, `enrich.mjs`) have no
runtime dependencies — only Node built-ins.

## Running the tests

```bash
npm test
```

73 tests, fully mocked HTTP, no live API. The `--test-force-exit` flag is a
safety net on Node ≥ 24 in case a test leaves an unawaited microtask; use
`npm run test:ci` to opt out.

## Type-checking

```bash
npm run typecheck
```

Type-checks `src/index.ts` against the `.d.mts` ambient declarations for
the `.mjs` runtime modules. Strict mode is on; please don't disable it.

## Project layout

```
src/
  index.ts           # Pi extension entrypoint (loaded by jiti at startup)
  core.mjs           # Pure logic: catalog fetch, classification, overrides
  core.d.mts         # Type declarations for core.mjs
  core.test.mjs      # Unit tests for core
  enrich.mjs         # Enrichment layer: GOAT page scrape + TTL cache
  enrich.d.mts       # Type declarations for enrich.mjs
  enrich.test.mjs    # Unit tests for enrich
  README.md          # User-facing documentation
```

`core.mjs` and `enrich.mjs` are deliberately plain ES module JavaScript so
they can be loaded by Pi's jiti runtime AND tested directly with
`node --test` without any compile step.

## Conventions

- **No new runtime dependencies.** The extension is intentionally tiny.
  Built-in Node APIs are enough.
- **All HTTP must be mockable for tests.** `fetchCatalog`, `fetchEnrichment`,
  `loadEnrichmentCache`, `loadModelOverrides`, and `saveEnrichmentCache`
  all accept injectable dependencies (`fetchImpl`, `fsImpl`, `cachePath`,
  `path`, `env`, `now`, `ttlMs`) so tests can run without I/O.
- **No secrets in logs, error messages, or tests.** The existing secret
  hygiene test in `core.test.mjs` covers this. If you add a new error
  path, extend the test.
- **Conservative defaults for fields Command Code does not publish.**
  Pricing defaults to `{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`
  rather than fabricating costs.
- **The `reasoning` flag is opt-in only.** It is set when enrichment
  metadata flags the model or when `inferClaudeThinking()` recognizes a
  Claude-family id. Never flip it speculatively.
- **`maxTokens` is raise-only.** Per-model overrides and the env-var
  default can raise the `/models` cap; neither can lower it.

## Adding a new env var

1. Document it in `src/README.md` (in the relevant section) and in
   `CHANGELOG.md` under `[Unreleased]`.
2. If the env var has a non-trivial validation, add a unit test that
   covers both the happy path and the rejection cases.
3. Document the failure mode — what happens on bad input? Silent fallback
   (consistent with existing env vars) or hard error?

## Adding a new heuristic

`inferClaudeThinking()` is the canonical example: a small pure function
that maps a model id to a Pi-relevant metadata fragment, with tests for
the positive cases, the negative cases, and the boundary cases (empty
id, undefined, future naming conventions that should not yet be
recognized).

## Submitting a change

1. Fork, branch, push.
2. Run `npm test` and `npm run typecheck` locally.
3. Open a pull request with:
   - a brief summary of the change
   - the motivation (which issue or upstream behavior it addresses)
   - a note on whether the public surface (env vars, override file shape,
     provider IDs) changed
4. CI must pass on Node 20, 22, and 24.

## Release process

1. Bump `version` in `package.json`.
2. Move the `[Unreleased]` section in `CHANGELOG.md` to a dated
   `[X.Y.Z]` section.
3. Tag and push the release.

The extension is published by mirroring this repository; there is no
`npm publish` step.