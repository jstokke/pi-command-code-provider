# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's
[private vulnerability reporting](https://github.com/jstokke/pi-command-code-provider/security/advisories/new)
instead, or email the maintainer if that is unavailable to you.

Include what makes the report actionable: affected version, Pi version, steps
to reproduce, and the impact you believe it has. I'll acknowledge as soon as I
see it. This is a side project maintained by one person, so please be patient
rather than assuming it has been ignored.

## Scope

This extension is a Pi package, which means it runs with the same trust as any
other Pi package: extensions execute arbitrary code, so review the source
before installing — including this one.

The design decisions that matter here:

- **The extension never stores your API key.** `/login command-code` hands the
  key to Pi, which persists it in `~/.pi/agent/auth.json`. The extension reads
  it back on demand through Pi's credential API, or from
  `COMMAND_CODE_API_KEY` in the environment.
- **The key is never logged.** Error and message paths are covered by the
  secret-hygiene tests in `src/core.test.mjs`; a regression there is a security
  bug, not a cosmetic one.
- **Outbound requests are limited to Command Code.** The extension calls
  `api.commandcode.ai` for the model catalog and reads Command Code's published
  GOAT plan page for pricing metadata. `COMMAND_CODE_ENRICHMENT_URL` can
  redirect the latter; if you set it, you choose where that traffic goes.
- **`CMD_ZDR=1` is opt-in.** It sends an `x-cmd-zdr: 1` header to request zero
  data retention. It is off unless you set it.
- **No install scripts and no runtime dependencies.** The package has no
  `preinstall`/`postinstall` hooks and ships no third-party code.

## Supported versions

The latest published version is the supported one. Fixes go into a new release
rather than a backport.
