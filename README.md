# opencode-rtk

[rtk](https://github.com/rtk-ai/rtk) integration for [OpenCode V2](https://opencode.ai/docs/build/plugins).

`opencode-rtk` transparently rewrites shell (`bash`) tool commands to their `rtk` equivalents
(`git status` → `rtk git status`, `ls` → `rtk ls`, …) and shows the token savings rtk
reports — without changing the agent's intent or what it observes on success.

## How it works

1. **`tool.execute.before`** — for the `bash` tool, the command is passed through `rtk rewrite`.
   Rewritten commands replace `event.input.command`. No-ops and unsupported commands are left
   untouched.
2. **Per-tool state** — the rewritten form and a start time are recorded by tool-call id so the
   savings for that exact invocation can be computed on completion.
3. **`tool.execute.after`** — when rtk records savings for the rewritten command, the plugin
   appends a savings note to the tool result. On failure it surfaces rtk's stderr so the
   agent sees a meaningful error.
4. **`/rtk` command** — show rewritten-command savings or toggle rewriting for the session.

## Install

Install [rtk](https://github.com/rtk-ai/rtk) (>= 0.23.0) and make sure `rtk` is on your `PATH`.

```bash
# install the plugin from this repo / package
# e.g. from your OpenCode config:
#   plugins: ["opencode-rtk"]  (once published) or a local path
```

Then enable it in `opencode.json` / `opencode.jsonc`:

```jsonc
{
  "plugins": ["opencode-rtk"]
}
```

## Configuration

The plugin is intentionally simple:

| Setting | Source | Default | Meaning |
|---|---|---|---|
| enabled | `/rtk on` / `/rtk off` (session) | `on` | Rewrite commands. Set `RTK_DISABLED=1` in the environment for a hard off-switch that `/rtk on` cannot override. |
| `showSavings` | plugin options | `true` | Append a savings note to rewritten tool results. |

Options example:

```jsonc
{
  "plugins": [
    ["opencode-rtk", { "showSavings": true }]
  ]
}
```

## The `/rtk` command

```
/rtk                # show status + savings summary
/rtk on             # enable rewriting for this session
/rtk off            # disable rewriting for this session
/rtk status         # show status
/rtk savings        # show session savings
```

## Notes

- **Transparent on success.** rtk preserves exit codes and produces equivalent output, so a
  rewritten command should look the same to the agent. A failure reports rtk's stderr.
- **Savings reporting.** Savings are computed from rtk's tracking data for the rewritten command.
- **Session scope.** `/rtk on|off` applies to the session that runs the command.
- **`RTK_DISABLED=1`.** Hard environment kill switch; `/rtk on` cannot override it.

## Development

```bash
cd opencode-rtk
bun install
bun test          # runs the core smoke tests (no OpenCode host required)
bunx tsc --noEmit
```

The command-rewrite logic lives in `src/rtk-core.ts` and is exercised by
`test/rtk-core.test.ts` with a fake `rtk` executable.

## License

MIT — see [LICENSE](./LICENSE).

- rtk itself: [rtk-ai/rtk](https://github.com/rtk-ai/rtk) (MIT/Apache-2.0, upstream).
