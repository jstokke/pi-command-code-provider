# Command Code provider for Pi

## Why I built this

I use [Pi](https://github.com/earendil-works/pi-coding-agent) for most of my
coding work and I subscribe to [Command Code](https://commandcode.ai) — they
route you across a long list of models through one API key, with one bill
and one place to manage quotas. But Pi didn't ship a Command Code provider,
and maintaining a `models.json` by hand was getting old: every time Command
Code added or removed a model (which is often), I'd have to update mine and
restart Pi.

So I wrote this extension. It pulls Command Code's live catalog at startup
and registers it as two Pi providers — one for OpenAI-shaped requests, one
for Anthropic-shaped. Add a model on Command Code's side and it shows up in
Pi the next time you launch. No restarts, no JSON to babysit.

**Heads up:** I have the GOAT subscription, which is the only tier I've
personally tested with. The `/models` endpoint and the GOAT-plan enrichment
page should behave the same for other Command Code subscriptions, but if
you run into something weird on a different tier, file an issue and I'll
take a look — I just can't promise I've seen it.

## TL;DR

The extension registers two native Pi providers that participate in Pi's
own `/login` flow:

| Provider id             | Display name            | Wire                |
|-------------------------|-------------------------|---------------------|
| `command-code`          | Command Code            | OpenAI Chat Completions |
| `command-code-anthropic`| Command Code (Anthropic)| Anthropic Messages  |

Both providers share one Command Code credential. To set up:

```
/login command-code
```

Pi prompts for the API key with masked input, validates it by hitting
`/models`, and persists it to `~/.pi/agent/auth.json`. The catalog fetch
happens lazily — Pi calls `refreshModels()` on first model use and on
`/model` refresh, not at extension startup. Each refresh is bounded 8s.

## Install

The easiest way to install is directly via Pi's package manager:

```bash
pi install git:github.com/jstokke/pi-command-code-provider
```

Or if you prefer HTTPS:

```bash
pi install https://github.com/jstokke/pi-command-code-provider
```

Pi clones the package, records it in `~/.pi/agent/settings.json`, and loads it at startup. To update later, run `pi update --extensions`.

### Development / Symlink

If you are developing or modifying the extension locally:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/src" ~/.pi/agent/extensions/command-code
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts` at startup. Restart Pi and `/model` will show Command Code as a provider (once you've logged in).

## Auth

The primary setup path is Pi's built-in `/login`:

```
/login command-code
```

Pi prompts for the API key with a masked secret input, validates it by
hitting `/models`, and persists the credential to `~/.pi/agent/auth.json`.
You can run the same flow against the Anthropic provider
(`/login command-code-anthropic`) — both providers share the same
`command-code` credential, so logging into either one authenticates both.

`/logout command-code` clears the credential. The `/login` selector
shows the source of the credential next to the provider name
("stored credential" or `COMMAND_CODE_API_KEY` for the env-var fallback).

Two fallbacks still work, in this order:

1. The `COMMAND_CODE_API_KEY` env var (handy for headless setups and CI).
2. A `command-code` entry in `~/.pi/agent/auth.json`:

   ```json
   { "command-code": { "type": "api_key", "key": "..." } }
   ```

   The extension reads this on every catalog refresh, so manual edits take
   effect on the next model use.

The key is never logged, printed, or echoed back in errors — there's a
test that grep-asserts this across every error path.

## Which protocol does a model use?

Command Code serves each model on the endpoint matching its API format, so
the extension has to pick the right one. `classifyWire()` in `core.mjs`
decides, in order:

1. an explicit `api_type` field from `/models`, if Command Code ever adds one
2. `owned_by` vendor metadata containing `anthropic`
3. model id matching `(^|/)claude` — the Claude family
4. everything else → OpenAI Chat Completions

If Command Code reshuffles how they tag models and routing breaks, that's
the one function to touch.

## Where the metadata comes from

`/models` gives me `id`, `name`, `owned_by`, `context_length`, `max_tokens`.
That's enough to register models but not enough to know prices, vision, or
which ones are reasoning models. So I scrape Command Code's published
[GOAT plan table](https://commandcode.ai/docs/plans/goat) for the rest.

- The page is cached at `~/.pi/agent/command-code-enrichment-cache.json`
  (respects `$PI_CODING_AGENT_DIR`) with a 24h TTL.
- The cache and the live catalog are fetched concurrently inside
  `refreshModels()`, bounded 8s each.
- If the scrape fails or times out, models fall back to conservative
  defaults (zero cost, `text` only, no reasoning flag) — it's better than
  not loading the provider at all.
- No API key is ever sent to the docs site.
- The page covers most but not all models. Claude and a handful of closed
  models aren't on the page; for those I either read the hint from the
  catalog or fall back to conservative defaults.

Two escape hatches if the docs page misbehaves:

```bash
# point at a mirror / local proxy if the live page is broken
export COMMAND_CODE_ENRICHMENT_URL='https://mirror.example.com/goat'

# or skip enrichment entirely and just use /models
export COMMAND_CODE_NO_ENRICHMENT=1
```

## Claude extended thinking

This is the part I'm most pleased with, because it was a real bug.

Command Code's docs page doesn't cover Claude, so without help every Claude
model would ship with `reasoning: false`. That meant Pi never enabled
extended thinking on any Claude model — and that defeated the 128k
`maxTokens` bump this extension otherwise applies to reasoning models.

`inferClaudeThinking()` in `core.mjs` recognizes Claude-family model ids
and:

- sets `reasoning: true` so Pi enables extended thinking
- emits a `thinkingLevelMap` so Pi's thinking-level picker actually
  exposes the top level

| Model                              | `reasoning` | `thinkingLevelMap`               |
|------------------------------------|-------------|----------------------------------|
| `claude-opus-4-7*`, `opus-4.7*`    | true        | `{ xhigh: "xhigh" }`             |
| `claude-sonnet-4-6*`, `sonnet-4.6*`| true        | `{ xhigh: "xhigh" }`             |
| `claude-opus-4-6*`, `opus-4.6*`    | true        | `{ xhigh: "max" }` (max is Opus 4.6-only) |
| Older Claude (Haiku, Sonnet 4.x and earlier) | true | (none — Pi hides `xhigh`, budget-based thinking is used) |
| Anything not Claude                | unchanged   | unchanged                        |

The shapes mirror Pi's `supportsAdaptiveThinking()` and Anthropic's
adaptive-effort vocabulary. Pi's `getSupportedThinkingLevels` filters
`xhigh` out unless the map contains an explicit entry, so without the map
even the highest available effort stays hidden in the picker.

## maxTokens (avoiding "Response was truncated")

Pi raises `Response was truncated before completion.` when a response ends
with `finish_reason="length"` — the model hit its output cap mid-stream.
This is most common on DeepSeek V4 Flash, Kimi, and Claude with extended
thinking, where the thinking budget alone can eat 30k-100k tokens before
the actual answer starts. See
[pi#7855](https://github.com/earendil-works/pi/issues/7855).

Per model, `maxTokens` resolves in this order:

1. `max_tokens` published by Command Code's `/models` — the **floor**;
   Command Code knows its own model's hard ceiling.
2. A per-model override from
   `~/.pi/agent/command-code-model-overrides.json` — can raise, never lower.
3. `COMMAND_CODE_DEFAULT_MAX_TOKENS` env var (positive integer) — uniform
   across reasoning and non-reasoning models.
4. Compile-time default: `131072` (128k) for reasoning models, `65536`
   (64k) otherwise.

The reasoning-model bump is automatic. Reasoning is set either by the
enrichment metadata (for non-Claude) or by the Claude heuristic. Models
with a published `max_tokens` are never overshot.

### Raising the global default

```bash
export COMMAND_CODE_DEFAULT_MAX_TOKENS=65536
```

Invalid values (`0`, `-1`, `12.5`, `abc`, …) fall back to the compile-time
default silently — same pattern as the rest of the env vars.

### Per-model overrides

Create `~/.pi/agent/command-code-model-overrides.json` (or the equivalent
under `$PI_CODING_AGENT_DIR`):

```json
{
  "deepseek/deepseek-v4-flash-latest": { "maxTokens": 65536 },
  "Claude Sonnet 5":                  { "maxTokens": 32768 }
}
```

- Keys can be the exact model id **or** the catalog's display name; I also
  index each key under a normalized form (lowercased, whitespace and
  punctuation stripped), so `Claude Sonnet 5`, `claude sonnet 5`, and
  `claudesonnet5` all match.
- Exact id wins on conflict.
- `maxTokens` and `contextWindow` are both supported. Values must be
  positive integers; anything else is silently dropped.
- Malformed JSON or wrong top-level shape logs one line at startup and the
  file is treated as empty.

One diagnostic line is printed at startup when the file has any effective
entries:

```
Command Code: applying 2 per-model override(s) from /home/you/.pi/agent/command-code-model-overrides.json.
```

## Zero data retention (opt-in)

```bash
export CMD_ZDR=1   # sends "x-cmd-zdr: 1" on every Command Code request
```

## Troubleshooting

The extension logs one line per thing that goes wrong. None of them include
your key.

- `Command Code: no COMMAND_CODE_API_KEY in env. Run \`/login command-code\``
  → first-time setup, or you cleared the credential. Run `/login` or set
  the env var.
- `Command Code: authentication failed (HTTP 401/403).` → the key is
  rejected; check it. `/login command-code` to re-enter.
- `Command Code: catalog fetch failed: …` → network or parse problem on
  `/models`; the provider still works for the previously-cached catalog
  (Pi persists it across sessions) but the next refresh will retry.
- `Command Code enrichment failed: … (using stale cached metadata | conservative defaults)`
  → docs scrape failed; the cache (or conservative defaults) is used
  instead. Delete the cache to force a refresh, point at a mirror with
  `COMMAND_CODE_ENRICHMENT_URL`, or skip with `COMMAND_CODE_NO_ENRICHMENT=1`.
- Models appear but requests fail with an API-format error → classification
  probably needs updating; `classifyWire()` is the only place to look.

## Tests

```bash
cd src
npm test
```

101 tests, fully mocked HTTP, no live API. They run in ~300ms.