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

109 tests, fully mocked HTTP, no live API. `node --test` runs them in about
300ms. The `--test-force-exit` flag is a safety net on Node ≥ 24 in case a
test leaves an unawaited microtask; `npm run test:ci` skips it.

## Type-checking

```bash
npm run typecheck
```

`tsc --noEmit`, strict mode, over `src/index.ts` and the `.d.mts` / `.d.ts`
declaration files. Please don't turn strict mode off.

What it does **not** cover is worth understanding, because the JavaScript is not
what gets checked:

- **The declaration files are not verified.** `skipLibCheck` is on, so TypeScript
  uses `core.d.mts` as the types for `core.mjs` without checking the contents of
  the declaration against the implementation. Turning it off is not an option:
  it reports 44 errors, all inside `@earendil-works/pi-ai`'s generated
  declarations, because `module: nodenext` rejects their JSON import attributes.
- **The `.mjs` modules are not type-checked.** `allowJs`/`checkJs` are off, and
  the modules carry no JSDoc, so enabling `checkJs` reports 69 errors. Doing this
  properly is a real piece of work (annotate the `.mjs`, then drop the
  hand-written declarations), not a config change.

So `npm run typecheck` checks that `src/index.ts` uses the declared interfaces
correctly. It does not check that the declarations match the implementations.
`src/declarations.test.mjs` closes the gap that matters most — every declared
value export must exist at runtime, and every runtime export must be declared —
but it cannot check argument or return types.

If you change what a `.mjs` module exports, or change a signature, update the
matching `.d.mts` by hand. Nothing will remind you except that test.

## Project layout

```
src/
  index.ts                    # Pi extension entrypoint (loaded by jiti at startup)
  core.mjs                    # Pure logic: catalog fetch, classification, overrides
  core.d.mts                  # Type declarations for core.mjs
  core.test.mjs               # Unit tests for core
  enrich.mjs                  # Enrichment layer: GOAT page scrape + TTL cache
  enrich.d.mts                # Type declarations for enrich.mjs
  enrich.test.mjs             # Unit tests for enrich
  native-provider.mjs         # Runtime Provider object: /login, refreshModels, wire dispatch
  native-provider.d.mts       # Type declarations for native-provider.mjs
  native-provider.test.mjs    # Unit tests for the provider
  pi-extension-augment.d.ts   # Augments ExtensionAPI.registerProvider with the runtime-provider overload
  declarations.test.mjs       # Asserts the .d.mts exports match the .mjs runtime exports
  README.md                   # User-facing technical documentation
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

## Release process

This extension is distributed straight from GitHub, not through npm, so a release
is just a version, a tag and a note. Nothing here publishes anything anywhere.

```bash
# 1. Move the [Unreleased] notes in CHANGELOG.md under a dated heading:
#    ## [X.Y.Z] — YYYY-MM-DD
# 2. Bump `version` in package.json to match.
# 3. Run the gates:
npm test && npm run typecheck
# 4. Commit, tag and push:
git commit -am "chore(release): vX.Y.Z"
git tag -a vX.Y.Z -m vX.Y.Z
git push --follow-tags
# 5. Create the GitHub release from the same CHANGELOG section:
gh release create vX.Y.Z --title vX.Y.Z --verify-tag --generate-notes
```

There is no build step, so what you tag is what people install. Tagging matters:
it is what lets someone pin a version with
`pi install git:github.com/jstokke/pi-command-code-provider@vX.Y.Z`.

### Do not publish this to npm

`package.json` sets `"private": true`, which makes `npm publish` refuse, and that
is deliberate rather than an oversight.

There is an existing, independently maintained package on npm called
[`pi-commandcode-provider`](https://www.npmjs.com/package/pi-commandcode-provider)
which does a very similar job for the same service. This repository's package
name, `pi-command-code-provider`, differs from it by one hyphen. Publishing would
put two near-identically named packages with the same purpose on the registry,
which helps nobody — so this project stays git-only. Please leave `private` as it
is.