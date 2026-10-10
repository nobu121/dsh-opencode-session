# dsh-opencode-session

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH)
plugin that automatically sends the **`x-opencode-session`** request header on
model calls routed to **OpenCode / OpenCode Go** providers — one stable
session id per DSH conversation.

## Why

Since 2026-09-05 OpenCode's relay requires an `x-opencode-session` header on
API requests (tracked upstream in
[deepseek-harness discussion #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495));
without it, requests fail with `400 MissingSessionID`-style errors. Requests
that share the same header value are pinned to the same upstream backend,
which is also what keeps OpenCode's prompt cache warm across the turns of one
conversation.

This plugin:

- **fixes the 400** by always attaching the header to OpenCode(Go) requests,
- **keeps the cache/affinity benefit** by using a value that is unique **per
  conversation** and stable across that conversation's turns (by default the
  DSH session id itself, the same identity the official DeepSeek adapter
  already sends as `x-deepseek-harness-session-id`),
- leaves every other provider, and every request that already carries the
  header, untouched.

## Install

From the npm registry (once published):

```sh
dsh plugin --profile web add dsh-opencode-session
```

From a local checkout:

```sh
dsh plugin --profile web add ./path/to/dsh-opencode-session
```

Then **fully restart** your dsh profile (bundle layers are read at startup).
The startup log shows:

```
[opencode-go-session-header] active for providers [opencode, opencode-go] with mode session-id
```

If you run DSH from a source checkout instead, load it as an overlay:
`pnpm dsh web --patch ./cordis.patch.yml`.

## Configuration

The plugin row lives in the bundle's `cordis.patch.yml`; all keys are optional:

```yaml
- insert:
    - id: opencode-go-session-header
      name: dsh-opencode-session
      config:
        providers: [opencode, opencode-go]   # route keys to attach the header to
        mode: session-id                     # 'session-id' | 'uuid'
        debug: false
        debugFile: null                      # optional absolute path
```

- `providers` — provider route keys whose requests get the header. The
  defaults cover the pi-ai catalog ids `opencode` and `opencode-go`; add your
  own route key when you serve OpenCode through a custom provider name.
- `mode`
  - `session-id` (default) — header value = the DSH session id of the model
    call. Unique per conversation, stable across turns, compaction, retries
    and process restarts.
  - `uuid` — a random UUID derived once per DSH session id (opaque; kept in
    memory, so it resets when the process restarts).
- `debug` — log every streamed call that receives the header via
  `ctx.logger` (the dsh process console).
- `debugFile` — optional absolute path. When set, every streamed call that
  receives the header appends one JSON line
  (`{"ts","provider","model","session","header","value"}`) to that file —
  handy when the dsh console is not visible.

To override configuration in a profile without editing the package, add a
row with the same id in the profile's own `cordis.patch.yml` (it replaces the
whole `config`, so restate every key).

## How it works

1. Listens on the `llm/stream` waterfall. A call whose `options.provider`
   names a configured OpenCode route is driven through an `AsyncLocalStorage`
   store holding the header value when it either carries a `sessionId` or runs
   inside a tool execution that names the session (item 4).
2. `globalThis.fetch` is patched once. While such a store is active, the
   outgoing request receives `x-opencode-session: <value>` (unless it already
   carries the header — an existing value always wins).
3. All registrations are fiber-scoped ctx effects: stopping / updating /
   unloading the plugin restores the original `fetch` and removes the
   listeners.
4. Auxiliary calls that omit `sessionId` — some plugins build their model
   requests by hand — are covered while they run inside a `tools/pre-execute`
   call: that listener runs the rest of the waterfall inside a session store,
   so for example the reviewer request of the experimental auto-review gate
   keeps its conversation's header. Only the `llm/stream` listener reads that
   store, so a tool body's own requests are never touched. The listener is
   registered on the first `llm/stream` so it always runs ahead of a gate that
   registered its own `tools/pre-execute` listener earlier.

Non-OpenCode providers, model discovery requests, and a request that neither
carries a `sessionId` nor runs inside a tool execution pass through untouched.

## Notes / limitations

- The header is attached to chat/streaming requests inside an `llm/stream`
  call. The one-shot model listing used by the Models page
  (`GET <baseURL>/models`) is a separate flow and does not receive the
  header; if your OpenCode endpoint also rejects that listing, open an issue.
- The plugin relies on DSH outbound LLM requests going through the Node
  global `fetch`. If a future DSH version swaps its network stack, the
  plugin stops injecting (symptom: the 400 comes back) — uninstall then.

## Development

```sh
node --check lib/index.js
npm test        # local behavior tests against an echo server
```

## Publishing (for maintainers)

The package is plain ESM JavaScript with zero dependencies; `npm test` runs
automatically via `prepublishOnly`.

```sh
npm login                       # once, with your npm account
npm pack --dry-run              # preview exactly what lands in the tarball
npm publish                     # files = lib/, cordis.patch.yml, README.md
```

Before publishing, double-check the name is free on the npm registry and fill
in `author`, `homepage`, and `repository` in `package.json` if you like.

## License

MIT
