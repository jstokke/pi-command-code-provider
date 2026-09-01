# pi-command-code-provider

A [Pi](https://github.com/earendil-works/pi-coding-agent) extension that
registers [Command Code](https://commandcode.ai) as a dynamic model provider.
Command Code's live catalog is fetched at startup, so new models show up on
the next Pi invocation — no manual `models.json` edits, no restarts.

The extension exposes two logical providers backed by the same API key:

- `command-code` — OpenAI Chat Completions wire (`openai-completions`)
- `command-code-anthropic` — Anthropic Messages wire (`anthropic-messages`)

Pricing and capability metadata are layered in from Command Code's published
GOAT plan table with a 24h TTL cache. Per-model `maxTokens` /
`contextWindow` overrides and global env-var defaults are supported.

Source of truth lives in [`src/`](src/). Symlink it into Pi's extensions
directory:

```bash
ln -s "$(pwd)/src" ~/.pi/agent/extensions/command-code
```

Everything else — install, auth, env vars, protocol routing, troubleshooting —
is in [`src/README.md`](src/README.md).

## Tests

```bash
cd src && node --test
```

73 tests, fully mocked HTTP, no live API calls.

## License

MIT — see [LICENSE](LICENSE).