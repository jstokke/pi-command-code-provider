---
name: Bug report
about: Something is broken or behaving unexpectedly
---

## What happened

A clear description of the bug.

## Reproduction

Steps to reproduce, ideally with a minimal config:

```bash
export COMMAND_CODE_API_KEY=...
pi
# then describe what you did
```

## Expected behavior

What you expected to happen instead.

## Environment

- Pi version (`pi --version`):
- Node version (`node --version`):
- OS:
- `COMMAND_CODE_API_KEY` set? (yes / no — never paste the key itself)
- `COMMAND_CODE_NO_ENRICHMENT` set?
- `CMD_ZDR` set?
- `~/.pi/agent/command-code-enrichment-cache.json` exists? (yes / no / not sure)
- `~/.pi/agent/command-code-model-overrides.json` exists? (yes / no / not sure)

## Logs

Anything relevant from `pi` output — particularly any line starting with
`Command Code:`. The key itself is never needed for diagnosis; please
redact it anyway.