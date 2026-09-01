# Command Code provider for Pi

Dynamic custom provider for Pi (`@earendil-works/pi-coding-agent`) that
exposes Command Code's live model catalog — no manually maintained
`models.json`, no hardcoded catalog, no Pi restarts when Command Code adds
or removes a model.

The catalog comes from Command Code's own API at startup; pricing and
capability metadata are layered in from Command Code's published GOAT plan
page, with a 24h TTL cache so the docs page is scraped at most once a day.

## Installation

Symlink (or copy) this directory into Pi's extensions folder:

```bash
ln -s /path/to/this/repo/src ~/.pi/agent/extensions/command-code
```

Pi auto-discovers `~/.pi/agent/extensions/*/index.ts` at startup. No
`settings.json` change is needed. Verify with `pi list` or by restarting Pi.

## Authentication

Exactly one credential is required, resolved in this order:

1. `export COMMAND_CODE_API_KEY='…'`
2. a stored `api_key` credential for provider id `command-code` in
   `~/.pi/agent/auth.json` (what `pi auth` manages):

```json
{ "command-code": { "type": "api_key", "key": "..." } }
```

The key is resolved at runtime and is never hardcoded, logged, or printed.

## How it works

At every Pi startup the async extension factory fetches:

```
GET https://api.commandcode.ai/provider/v1/models
Authorization: Bearer $COMMAND_CODE_API_KEY
```

(8s `AbortController` timeout, single attempt — startup stays bounded.)
The response is converted into Pi model definitions and split into two logical
providers backed by the same account:

| Provider id             | Display name            | API                  | baseUrl                          |
|-------------------------|-------------------------|----------------------|----------------------------------|
| `command-code`          | Command Code            | `openai-completions` | `…/provider/v1` (SDK appends `/chat/completions`) |
| `command-code-anthropic`| Command Code (Anthropic)| `anthropic-messages` | `…/provider` (SDK appends `/v1/messages`) |

Newly added Command Code models appear on the next Pi invocation; removed
models disappear. `/model` and `pi --list-models` reflect the live catalog.

A startup line is always logged so a silent regression (empty catalog,
misclassification, etc.) is visible:

```
Command Code: registered 47 model(s) (45 openai, 2 anthropic).
```

### Protocol routing

Command Code requires each model to use the endpoint matching its API format.
`classifyWire()` decides, in order:

1. explicit `api_type` field from `/models` (if Command Code ever adds one)
2. `owned_by` vendor metadata containing `anthropic`
3. model id matching `(^|/)claude` (Claude family)
4. documented default: everything else → OpenAI Chat Completions

### Metadata mapping

Observed `/models` fields: `id`, `name`, `owned_by`, `context_length`,
`max_tokens`. Pricing, vision, and reasoning metadata are **enriched** from
Command Code's published GOAT plan model table
([commandcode.ai/docs/plans/goat](https://commandcode.ai/docs/plans/goat))
which lists 43/63 in-plan models with per-million-token prices and capability
flags. The enrichment is non-fatal: a scrape failure logs one line and the
extension falls back to conservative defaults.

- Cache: `~/.pi/agent/command-code-enrichment-cache.json` (respects
  `$PI_CODING_AGENT_DIR`), TTL 24h. The page is re-scraped concurrently with
  `/models` (bounded 8s) only when the cache is missing or stale; otherwise
  the cache is used. No API key is ever sent to the docs site.
- For models the page does not cover (all Claude plus a handful of closed
  models), the conservative defaults from `core.mjs` apply.
- Pricing, vision, and reasoning are filled only when the page reports them;
  `/models` context_length always wins.

Override the enrichment URL (for resilience against docs-page restructuring):

```bash
export COMMAND_CODE_ENRICHMENT_URL='https://mirror.example.com/goat'
```

Skip enrichment entirely when the docs page is unreachable or unhelpful:

```bash
export COMMAND_CODE_NO_ENRICHMENT=1
```

## Claude extended thinking

The GOAT enrichment page does not cover Claude models, so without help every
Claude model would ship with `reasoning: false` and Pi would never enable
extended thinking — defeating the 128k `maxTokens` bump this extension
otherwise applies.

`inferClaudeThinking()` in `core.mjs` flips `reasoning: true` for any
claude-family model id and emits a `thinkingLevelMap` so Pi's thinking-level
UI exposes the appropriate maximum level:

| Model family                    | `reasoning` | `thinkingLevelMap`             |
|---------------------------------|-------------|--------------------------------|
| `claude-opus-4-7*`, `opus-4.7*` | true        | `{ xhigh: "xhigh" }`           |
| `claude-sonnet-4-6*`, `sonnet-4.6*` | true    | `{ xhigh: "xhigh" }`           |
| `claude-opus-4-6*`, `opus-4.6*` | true        | `{ xhigh: "max" }` (max is Opus 4.6-only) |
| Older Claude (Haiku, Sonnet 4.x and earlier, etc.) | true | (none — Pi hides xhigh, budget-based thinking is used) |
| Non-Claude                      | unchanged   | unchanged                      |

The shapes mirror Pi's `supportsAdaptiveThinking()` and Anthropic's
adaptive-effort vocabulary. Pi's `getSupportedThinkingLevels` filters
`xhigh` out unless the map contains an explicit entry — without the map,
even the highest available effort would be hidden from the picker.

## Output limits (avoiding "Response was truncated")

Pi raises `Response was truncated before completion.` when a response
ends with `finish_reason="length"` — i.e. the model hit its output cap
before producing the terminal event. The most common cause is an
`max_tokens` / `max_completion_tokens` cap that is too small for the
model's thinking budget, especially on reasoning models (DeepSeek V4
Flash, Kimi, Claude with extended thinking, etc.). See
[pi#7855](https://github.com/earendil-works/pi/issues/7855) for upstream
confirmation.

This extension resolves `maxTokens` per Pi model definition in this order:

1. `max_tokens` published by Command Code's `/models` — authoritative on
   the **low** end (Command Code knows its own model's hard ceiling).
2. A per-model override from
   `~/.pi/agent/command-code-model-overrides.json` (see below) — may
   raise the cap if larger.
3. `COMMAND_CODE_DEFAULT_MAX_TOKENS` env var (positive integer) — when
   set, applies uniformly to both reasoning and non-reasoning models.
4. A per-class compile-time default selected by the reasoning flag:
   `131072` (128k) for reasoning models, `65536` (64k) otherwise.

The reasoning-model bump is automatic and requires no configuration.
Either the enrichment metadata or the Claude-family heuristic can flag a
model as reasoning; the bump applies whichever path fires. Models with a
known lower `max_tokens` in `/models` are never overshot.

The override can only raise, never lower — it cannot bypass a cap that
Command Code itself publishes.

### Raising the global default

```bash
export COMMAND_CODE_DEFAULT_MAX_TOKENS=65536
```

Invalid values (`0`, `-1`, `12.5`, `abc`, …) fall back to the compile-time
default silently.

### Per-model overrides

Create `~/.pi/agent/command-code-model-overrides.json` (or the equivalent
under `$PI_CODING_AGENT_DIR`):

```json
{
  "deepseek/deepseek-v4-flash-latest": { "maxTokens": 65536 },
  "Claude Sonnet 5":                  { "maxTokens": 32768 }
}
```

- Keys can be exact model ids **or** the catalog's display name; the
  extension also indexes each key under a normalized form (lowercased,
  whitespace and punctuation stripped) so `Claude Sonnet 5`,
  `claude sonnet 5`, and `claudesonnet5` all match.
- Exact id wins on conflict.
- `maxTokens` and `contextWindow` are both supported. Values must be
  positive integers; anything else (zero, negative, float, string) is
  silently dropped.
- Malformed JSON or wrong top-level shape logs one line at startup and
  the file is treated as empty.
- One diagnostic line is printed at startup when the file has any
  effective entries:

  ```
  Command Code: applying 2 per-model override(s) from /home/you/.pi/agent/command-code-model-overrides.json.
  ```

## Zero data retention (optional)

```bash
export CMD_ZDR=1   # sends "x-cmd-zdr: 1" on all Command Code requests
```

## Troubleshooting

- `Command Code: COMMAND_CODE_API_KEY is not set …; provider not registered.`
  → export the env var or add the auth.json credential above.
- `Command Code: authentication failed (HTTP 401/403).` → the key is rejected;
  check the credential. The key itself is never included in the message.
- `Command Code: model discovery failed: …` → network/HTTP/parse problem; the
  provider is simply unavailable for that invocation and Pi remains usable.
- `Command Code enrichment failed: … (using stale cached metadata | conservative defaults)`
  → the docs scrape failed or timed out; the cache (or conservative defaults)
  are used instead. Delete `~/.pi/agent/command-code-enrichment-cache.json`
  to force a refresh, set `COMMAND_CODE_ENRICHMENT_URL` to a mirror, or set
  `COMMAND_CODE_NO_ENRICHMENT=1` to skip enrichment entirely.
- `Command Code: registered 0 model(s) …` → no models passed classification;
  Pi stays usable but this provider contributes nothing. Check that the
  key is valid and `/models` is returning entries.
- `Command Code: registered N model(s) (0 openai, M anthropic)` → everything
  classified as Anthropic; `classifyWire()` in `core.mjs` is the only
  place to touch.
- Models appear but requests fail with an API-format error → the catalog
  classification may need updating; `classifyWire()` in `core.mjs` is the only
  place to touch.

## Tests

```bash
cd src
node --test --test-timeout=8000 --test-force-exit core.test.mjs enrich.test.mjs
```

73 tests, fully mocked HTTP, no live API calls. The `--test-force-exit` flag
is a safety net on Node ≥ 24 in case a test leaves an unawaited microtask.