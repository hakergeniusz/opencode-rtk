# opencode-rtk

Native [OpenCode V2](https://opencode.ai/docs/build/plugins) port of
[`pi-rtk`](https://github.com/hakergeniusz/pi-rtk).

Every bash command the agent runs is quietly rewritten into its
[rtk](https://github.com/rtk-ai/rtk) equivalent before execution, so command
output reaches the model token-optimized instead of raw. `/rtk saved` reports
the savings rtk itself measured.

rtk is a CLI proxy that filters and summarizes command output before it reaches
an LLM's context (`rtk grep` instead of `grep`, `rtk git status` instead of
`git status`, …). This plugin hooks OpenCode's `tool.execute.before` event, asks
`rtk rewrite` what the command should be, and mutates the call when there is an
equivalent. Commands with no rtk equivalent, already-rtk commands, and non-bash
tools pass through untouched. Multi-line scripts that rtk declines as a whole
(e.g. because of `$(...)`) are retried line by line; heredoc bodies and comments
are left verbatim.

Requires **rtk >= 0.23.0** in `PATH` (when `rtk rewrite` was introduced). If it
is missing or too old, the plugin fails open: it logs a warning and registers
nothing, so commands run raw.

## Commands

| Command | What it does |
|---|---|
| `/rtk saved` | Savings summary — this session and rtk's lifetime totals — injected into the session transcript |
| `/rtk status` | Detected rtk version, rewrite state, commands rewritten this session |
| `/rtk off` | Pause rewriting for this session; commands run raw |
| `/rtk on` | Resume rewriting |

`/rtk stats` is accepted as an alias for `/rtk saved`.

Set `RTK_DISABLED=1` in the environment for a hard kill switch that `/rtk on`
cannot override. The same switch can be passed as a plugin option:

```jsonc
{
  "plugins": [
    {
      "package": "opencode-rtk",
      "options": { "disabled": true }
    }
  ]
}
```

## How the savings are measured

The summary does not guess — it reads rtk's own tracker (`rtk gain --format
json`), which measures the raw vs. compressed output of every command rtk runs:

- **This session** — the difference in rtk's tracker since this session started
  (snapshot taken at plugin load and on `session.created`), plus the exact count
  of commands this plugin rewrote. The delta counts all rtk usage in that
  window, so another tool running rtk concurrently also contributes. If the
  tracker was reset mid-session (`rtk gain --reset`), the delta clamps to zero.
- **rtk lifetime** — rtk's global totals as reported by `rtk gain`.

All rewrite decisions are delegated to `rtk rewrite` — the plugin contains no
rules of its own, so rtk's registry stays the single source of truth.

## Load

Add the plugin to `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-rtk"]
}
```

It also works from a local checkout:

```jsonc
{
  "plugins": ["/home/hakergeniusz/Projects/opencode-rtk"]
}
```

## Mapping from the pi original

| pi concept | OpenCode V2 equivalent used here |
|---|---|
| `pi.registerTool` / tool-call mutation via `pi.on("tool_call")` | `ctx.tool.hook("execute.before", ...)`; mutates `event.input.command` for the `bash` tool |
| `pi.exec("rtk", args)` | `node:child_process.execFile` (the V2 plugin SDK has no generic exec API) |
| `pi.registerCommand("rtk", …)` | `ctx.command.transform` → `editor.add({ name: "rtk", … })`; subcommand parsed from `prompt.text` |
| `pi.on("session_start")` | snapshot at `setup` + `ctx.event.subscribe` for `session.created` |
| `pi.appendEntry` / `registerEntryRenderer` savings card | plain text via `ctx.session.synthetic` (see gaps) |
| `ctx.ui.notify` / `setStatus` | server log warnings; session messages via `ctx.session.synthetic` |
| `RTK_DISABLED` env | `process.env.RTK_DISABLED` plus `ctx.options.disabled` |
| extension load / shutdown | `Plugin.define({ setup })` and its returned cleanup function |
| `pi-tui` `Box`/`Text` renderer | not used (no TUI part) |

The behavior (rewrite rules, multi-line fallback, heredoc handling, counters,
clamping, fail-open) lives in `src/rtk-core.ts`; `src/index.ts` is a thin
OpenCode adapter.

## Known gaps

- **Styled transcript card.** pi used a custom `registerEntryRenderer` themed
  `Box`. OpenCode's server API has no custom transcript-entry renderer, so
  `/rtk saved` injects a plain-text synthetic message instead of a themed box.
  It is created with `resume: false`, so it is shown to the user without
  scheduling an agent turn — it still never reaches the model, just as in pi.
- **Status-bar notice.** When rtk is missing or too old, pi set a TUI status
  bar entry. There is no server-side status API, so only a server log warning
  is emitted.
- **Argument completions.** pi's `getArgumentCompletions` for `/rtk` has no
  direct V2 equivalent in `ctx.command.transform`; the subcommands work but are
  not offered as typed completions.
- **Session scoping.** pi tracked a single session. V2 has no `session_start`
  hook; state resets at plugin load and on `session.created` events, so
  concurrent sessions share one counter/snapshot.
- **Cancellation.** pi passed `ctx.signal` from its `tool_call` event to cancel
  an in-flight `rtk rewrite`. OpenCode's `execute.before` hook exposes no
  `AbortSignal`, so the subprocess is bounded only by the 2 s timeout.
- **No TUI part.** Status widgets, keybindings and custom markdown rendering
  were intentionally not ported; only the server part is implemented.

## Tests

The original pi smoke test was ported to the host-independent core with a fake
`rtk` executable (no network, no real rtk). Run it with:

```bash
bun test/rtk-core.test.ts
```

## Credits

- [rtk-ai/rtk](https://github.com/rtk-ai/rtk) (Apache-2.0) — does all the work;
  this plugin is a thin delegator around `rtk rewrite` and `rtk gain`.
- Sibling project: [pi-rtk](https://github.com/hakergeniusz/pi-rtk), the pi
  extension this was ported from.

## License

[MIT](LICENSE) — 2026 hakergeniusz.
