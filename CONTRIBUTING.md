# Contributing

Thanks for considering a PR. This is a small extension — most changes
touch one of three files (`src/index.ts`, `src/core.mjs`, `src/enrich.mjs`)
plus tests.

I'm a solo dev, so response times are whatever they are. If something's
sitting unanswered for a week, ping me.

## Running the tests

```bash
npm install
npm test
```

73 tests, fully mocked HTTP, no live API. `node --test` runs them in about
300ms. The `--test-force-exit` flag is a safety net on Node ≥ 24 in case a
test leaves an unawaited microtask; `npm run test:ci` skips it.

## Type-checking

```bash
npm run typecheck
```

`tsc --noEmit` against the `core.d.mts` / `enrich.d.mts` ambient
declarations. Strict mode is on; please don't turn it off.

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
they load via Pi's jiti runtime AND test with `node --test` without a
compile step.

## Things I care about

- **No new runtime dependencies.** The extension is intentionally tiny.
  Built-in Node APIs are enough; please don't add a runtime dep without a
  really good reason.
- **All HTTP must be mockable for tests.** `fetchCatalog`,
  `fetchEnrichment`, `loadEnrichmentCache`, `loadModelOverrides`, and
  `saveEnrichmentCache` all accept injectable dependencies (`fetchImpl`,
  `fsImpl`, `cachePath`, `path`, `env`, `now`, `ttlMs`) so tests run
  without I/O.
- **No secrets in logs, errors, or tests.** The existing secret-hygiene
  test in `core.test.mjs` covers every error path. If you add a new one,
  extend the test.
- **Conservative defaults for fields Command Code doesn't publish.**
  Pricing defaults to all-zero rather than fabricated costs. The
  `reasoning` flag is opt-in only (from enrichment metadata or the Claude
  heuristic) — never speculative.
- **`maxTokens` is raise-only.** Per-model overrides and the env-var
  default can raise the `/models` cap; neither can lower it.

## Adding a new env var

1. Document it in `src/README.md` and `CHANGELOG.md` under `[Unreleased]`.
2. Add a unit test covering both the happy path and the rejection cases
   if the env var has non-trivial validation.
3. Document the failure mode — silent fallback (consistent with existing
   env vars) or hard error.

## Adding a new heuristic

`inferClaudeThinking()` is the canonical example: a small pure function
that maps a model id to a Pi-relevant metadata fragment, with tests for
positive cases, negative cases, and boundary cases (empty id, undefined,
future naming conventions that should not yet be recognized).

## Submitting a change

1. Fork, branch, push.
2. `npm test` and `npm run typecheck` locally.
3. Open a PR with:
   - a short summary
   - the motivation (issue, upstream behavior, whatever)
   - whether the public surface changed (env vars, override file shape,
     provider IDs)
4. CI must pass on Node 20, 22, and 24.

## Release process (for me)

1. Bump `version` in `package.json`.
2. Move `[Unreleased]` in `CHANGELOG.md` to a dated `[X.Y.Z]` section.
3. Tag and push.

There's no `npm publish` step — the package is `private: true` and the
extension is installed by symlinking this repo into Pi's extensions
folder.