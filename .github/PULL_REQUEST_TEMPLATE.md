## What this changes

<!-- One or two sentences. -->

## Why

<!-- The motivation: an issue, upstream behaviour, a Command Code catalog change. -->

## Public surface

Does this change anything users depend on? Tick what applies, or "none".

- [ ] Provider ids (`command-code`, `command-code-anthropic`)
- [ ] Environment variables
- [ ] The override file shape (`~/.pi/agent/command-code-model-overrides.json`)
- [ ] Model ids, pricing, or capability flags
- [ ] None

## Checklist

- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] `CHANGELOG.md` updated under `[Unreleased]` if user-visible
- [ ] No secrets in code, tests, logs, error messages, or this description

Untested tiers are worth a note: this has only been exercised against a GOAT
subscription. If your change touches `/models` handling or enrichment, say what
you tested against.
