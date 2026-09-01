# pi-command-code-provider

A Pi extension that registers
[Command Code](https://commandcode.ai) as a dynamic model provider.

I built it because I subscribe to Command Code and got tired of
maintaining a `models.json` by hand — every time they added a model I'd
have to update mine and restart Pi. This extension pulls the live
catalog at startup, so new models just show up.

It exposes two providers backed by the same key, both participating in
Pi's built-in `/login` flow:

- `command-code` — OpenAI Chat Completions wire
- `command-code-anthropic` — Anthropic Messages wire

Pricing and capability metadata are layered in from Command Code's
published GOAT plan table, cached on disk for 24h. Per-model maxTokens /
contextWindow overrides are supported.

**Caveat:** I have the GOAT subscription, which is the only tier I've
personally tested. Should work on other Command Code subscriptions too,
but if something breaks I want to be upfront that I haven't seen it.

## Install

```bash
ln -s "$(pwd)/src" ~/.pi/agent/extensions/command-code
```

Then in Pi:

```
/login command-code
```

That's it. Paste your Command Code API key at the prompt, and `/model`
will list the live catalog.

Everything else — auth fallbacks, env vars, how it works, troubleshooting —
is in [`src/README.md`](src/README.md).

## Tests

```bash
cd src && npm test
```

101 tests, fully mocked HTTP, no live API.

## License

MIT — see [LICENSE](LICENSE).