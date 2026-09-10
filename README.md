# pi-command-code-provider

A Pi extension that registers [Command Code](https://commandcode.ai) as a dynamic model provider.

I built it because I subscribe to Command Code and got tired of maintaining a `models.json` by hand — every time they added or removed a model, I'd have to update mine and restart Pi. This extension pulls Command Code's live catalog, so new models just show up.

It exposes two providers backed by the same key, both participating in Pi's built-in `/login` flow:

| Provider ID | Display Name | Wire Protocol |
| :--- | :--- | :--- |
| `command-code` | Command Code | OpenAI Chat Completions |
| `command-code-anthropic` | Command Code (Anthropic) | Anthropic Messages |

Pricing and capability metadata are layered in from Command Code's published GOAT plan table, cached on disk for 24h. Per-model `maxTokens` and `contextWindow` overrides are supported, with automatic extended-thinking support for Claude models.

> **Note:** I have the GOAT subscription, which is the only tier I've personally tested. The `/models` endpoint and GOAT-plan enrichment should behave the same for other Command Code subscriptions, but if something breaks on another tier, please file an issue!

---

## Quickstart (Baby Steps)

Setting this up takes three simple steps:

### Step 1: Install the extension

Run this single command in your terminal:

```bash
pi install git:github.com/jstokke/pi-command-code-provider
```

To pin a specific release, add the tag:

```bash
pi install git:github.com/jstokke/pi-command-code-provider@v0.3.0
```

*(The HTTPS form works too: `pi install https://github.com/jstokke/pi-command-code-provider`)*

That's it! Pi downloads the extension, registers it in `~/.pi/agent/settings.json`, and loads it automatically whenever you run `pi`.

> **Not on npm.** This extension is distributed only from this repository. There
> is a separate, independently maintained package called
> [`pi-commandcode-provider`](https://www.npmjs.com/package/pi-commandcode-provider)
> on npm — the names differ by a single hyphen, so make sure you have the one you
> intended.

### Step 2: Log in with your API key

Start Pi (or run this inside an existing Pi session):

```text
/login command-code
```

When prompted, paste your Command Code API key (grab one from [commandcode.ai](https://commandcode.ai)).

- Pi prompts with a masked secret input, validates the key against Command Code's API, and securely saves it to `~/.pi/agent/auth.json`.
- **You only need to do this once.** Both `command-code` and `command-code-anthropic` share the same credential, so logging into either one authenticates both.

### Step 3: Pick a model and start coding

In Pi, open the model picker:

```text
/model
```

You'll see the live Command Code catalog (e.g. `command-code/deepseek/...`, `command-code/gpt-...`, or `command-code-anthropic/claude-...`).

Pick any model, press Enter, and start coding!

---

## Managing the Extension

### Updating

Whenever updates or fixes are released, update your installed Pi extensions with:

```bash
pi update --extensions
```

*(Or `pi update --all` to update both Pi and all packages.)*

### Uninstalling

If you ever want to remove the extension:

```bash
pi remove git:github.com/jstokke/pi-command-code-provider
```

---

## Alternative Setup Methods

### Headless / CI (Environment Variable)

For headless servers, scripts, or CI environments where an interactive `/login` prompt isn't possible, set the environment variable:

```bash
export COMMAND_CODE_API_KEY="your-command-code-api-key"
```

The extension checks `COMMAND_CODE_API_KEY` first before falling back to `auth.json`.

### Local Development / Contributing

If you want to clone this repository and hack on the code directly:

```bash
# 1. Clone the repository
git clone https://github.com/jstokke/pi-command-code-provider.git
cd pi-command-code-provider

# 2. Install the local directory into Pi
pi install .
```

*Tip for live development:* If you want Pi to reflect edits immediately without reinstalling, symlink `src/` into your Pi extensions directory:

```bash
mkdir -p ~/.pi/agent/extensions
ln -s "$(pwd)/src" ~/.pi/agent/extensions/command-code
```

---

## How It Works

### Wire Protocol Classification

Command Code serves each model on the endpoint matching its API format. The extension inspects each model and routes it automatically (`classifyWire()` in `src/core.mjs`):

1. Explicit `api_type` field from `/models`, if Command Code ever provides one.
2. `owned_by` vendor metadata containing `anthropic`.
3. Model ID matching `(^|/)claude` (the Claude family).
4. Everything else defaults to OpenAI Chat Completions.

### Metadata & Pricing Enrichment

Command Code's `/models` endpoint supplies `id`, `name`, `owned_by`, `context_length`, and `max_tokens`, but lacks pricing, vision support flags, and reasoning model indicators.

The extension scrapes Command Code's published [GOAT plan table](https://commandcode.ai/docs/plans/goat) to fill in the missing details:

- Scraped metadata is cached at `~/.pi/agent/command-code-enrichment-cache.json` (respects `$PI_CODING_AGENT_DIR`) with a **24-hour TTL**.
- The cache and live catalog are fetched lazily inside Pi's `refreshModels()` callback (on first model use or `/model` refresh, bounded to 8s).
- If the docs site is unreachable or times out, models fall back to safe defaults (zero cost, text only, no reasoning flag).
- **No API key is ever sent to the docs site.**

Two escape hatches:

```bash
# Point to a mirror/proxy if the docs page moves:
export COMMAND_CODE_ENRICHMENT_URL="https://mirror.example.com/goat"

# Skip scraping entirely and rely only on /models:
export COMMAND_CODE_NO_ENRICHMENT=1
```

### Claude Extended Thinking

Command Code's docs table does not list Claude models, meaning they would default to `reasoning: false` and miss out on extended thinking.

The extension detects Claude-family model IDs (`inferClaudeThinking()` in `src/core.mjs`) and:
- Enables `reasoning: true` so Pi turns on extended thinking.
- Emits a `thinkingLevelMap` so Pi's thinking level picker exposes the top levels (`xhigh` / `max`):

| Model | `reasoning` | `thinkingLevelMap` |
| :--- | :--- | :--- |
| `claude-opus-4-7*`, `opus-4.7*` | `true` | `{ xhigh: "xhigh" }` |
| `claude-sonnet-4-6*`, `sonnet-4.6*` | `true` | `{ xhigh: "xhigh" }` |
| `claude-opus-4-6*`, `opus-4.6*` | `true` | `{ xhigh: "max" }` |
| Older Claude (Haiku, Sonnet 4.x) | `true` | *(None — budget-based thinking used)* |
| Non-Claude models | *Unchanged* | *Unchanged* |

### Avoiding "Response was truncated" (`maxTokens`)

When an LLM response cuts off with `finish_reason="length"`, Pi raises `Response was truncated before completion.` This often happens on DeepSeek V4 Flash, Kimi, and Claude with extended thinking because the reasoning tokens consume part of the output budget.

Per model, `maxTokens` is resolved in order (raise-only):

1. **`max_tokens` from `/models`**: The floor set by Command Code.
2. **Per-model override**: From `~/.pi/agent/command-code-model-overrides.json` (can raise, never lower).
3. **`COMMAND_CODE_DEFAULT_MAX_TOKENS`**: Global env var override.
4. **Compile-time defaults**: `131072` (128k) for reasoning models, `65536` (64k) otherwise.

To raise the global default:

```bash
export COMMAND_CODE_DEFAULT_MAX_TOKENS=65536
```

### Per-Model Overrides

Create `~/.pi/agent/command-code-model-overrides.json` (or under `$PI_CODING_AGENT_DIR`):

```json
{
  "deepseek/deepseek-v4-flash-latest": { "maxTokens": 65536 },
  "Claude Sonnet 5":                  { "maxTokens": 32768 }
}
```

- Keys can be the model ID or catalog display name (case- and whitespace-insensitive).
- Supports `maxTokens` and `contextWindow` (must be positive integers).

### Zero Data Retention (Opt-In)

To send the `x-cmd-zdr: 1` header on every request to Command Code:

```bash
export CMD_ZDR=1
```

---

## Troubleshooting

The extension prints concise, actionable diagnostics without ever logging your API key:

- **`Command Code: no API key found. Run \`/login command-code\` in Pi...`**  
  First-time setup or cleared credentials. Run `/login command-code` or set `COMMAND_CODE_API_KEY`.
- **`Command Code: authentication failed (HTTP 401/403).`**  
  The API key was rejected by Command Code. Check your key and re-run `/login command-code`.
- **`Command Code: catalog fetch failed: ...`**  
  Network or parsing error reaching `/models`. Pi continues using the previously cached catalog, and will retry on the next refresh.
- **`Command Code enrichment failed: ... (using stale cached metadata | conservative defaults)`**  
  Failed to scrape the GOAT documentation page. Stale cached data or conservative defaults are used.

---

## Tests & Validation

Run the test suite:

```bash
npm test
```

106 unit tests (109 including the declaration-consistency tests), fully mocked HTTP, zero live API dependencies. Runs in ~300ms.

Run type-checking:

```bash
npm run typecheck
```

---

## Disclaimer

Not affiliated with, endorsed by, or sponsored by Command Code. "Command Code",
and the model names referenced by its catalog, are trademarks of their
respective owners, used here only to describe what this extension interoperates
with. The `command-code` GOAT pricing table is read from a public Command Code
page; check that this fits their terms for your own use.

---

## License

[MIT](LICENSE) © Joachim Stokke