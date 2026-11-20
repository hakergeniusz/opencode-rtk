/**
 * opencode-rtk — rtk integration for OpenCode V2.
 *
 * Rewrites the agent's bash commands to their rtk equivalents
 * (https://github.com/rtk-ai/rtk) before execution, so tool output reaches the
 * model token-optimized instead of raw. Adds `/rtk saved`, `/rtk status`,
 * `/rtk on` and `/rtk off`.
 *
 * This is a thin delegator: all rewrite policy lives in `rtk rewrite`, which
 * remains the single source of truth. The host-specific wiring lives here;
 * all behavior is in `src/rtk-core.ts`.
 */

import { Plugin } from "@opencode/plugin"
import { execFile, type ChildProcess } from "node:child_process"
import {
  ExecResult,
  ExecFn,
  RtkEngine,
  formatSavings,
  type SavingsData,
} from "./rtk-core"

/** Run `rtk` as a child process with a timeout and optional cancellation. */
const runProcess: ExecFn = (command, args, options = {}) => {
  return new Promise<ExecResult>((resolve) => {
    let child: ChildProcess | undefined
    const onAbort = () => child?.kill()
    const finish = (
      err: (Error & { code?: string | number; killed?: boolean }) | null,
      stdout: string,
    ) => {
      if (options.signal && "removeEventListener" in options.signal) {
        options.signal.removeEventListener("abort", onAbort)
      }
      const code = typeof err?.code === "number" ? err.code : err ? 1 : 0
      resolve({ code, stdout: stdout ?? "", killed: Boolean(err?.killed) })
    }

    try {
      child = execFile(
        command,
        args,
        { timeout: options.timeout ?? 2_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => finish(err, stdout),
      )
      if (options.signal) {
        if (options.signal.aborted) child.kill()
        else options.signal.addEventListener("abort", onAbort, { once: true })
      }
    } catch {
      resolve({ code: 1, stdout: "", killed: false })
    }
  })
}

/**
 * Send a short, user-facing message into the session transcript.
 * `resume: false` admits the synthetic message without scheduling an agent
 * turn, so it is displayed to the user but never reaches the model.
 */
async function present(ctx: any, sessionID: string, text: string): Promise<void> {
  try {
    await ctx.session.synthetic({ sessionID, text, resume: false })
  } catch (err) {
    // A host without session.synthetic still gets the text in its server log.
    console.log("[rtk]", text)
    console.warn("[rtk] could not inject session message", err)
  }
}

export default Plugin.define({
  id: "rtk",
  async setup(ctx) {
    // `RTK_DISABLED=1` is the hard kill switch; plugin options can mirror it:
    //   { "package": "opencode-rtk", "options": { "disabled": true } }
    const hardDisabled =
      process.env.RTK_DISABLED === "1" || (ctx.options as { disabled?: unknown })?.disabled === true

    const engine = new RtkEngine(runProcess, { hardDisabled })
    await engine.init()

    if (!engine.available) {
      // Fail open: no rewrite hook, no commands.
      // V2 has no server-side status-bar widget; the reason is logged instead.
      console.warn(`[rtk] ${engine.unavailableReason ?? "rtk unavailable"} — plugin disabled`)
      return
    }

    // Snapshot rtk's gain tracker at load time, and again whenever a session is
    // created.
    await engine.onSessionStart().catch(() => {})

    const events = new AbortController()
    void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ signal: events.signal })) {
          if (event.type === "session.created") {
            await engine.onSessionStart().catch(() => {})
          }
        }
      } catch {
        // Stream closed during cleanup.
      }
    })()

    await ctx.tool.hook("execute.before", async (event: any) => {
      if (event?.tool !== "bash") return
      const input = event.input as { command?: unknown } | undefined
      if (!input || typeof input.command !== "string") return

      // V2's `execute.before` event has no AbortSignal field, so the rtk
      // subprocess cannot be cancelled from the hook here.
      const rewritten = await engine.rewriteBashCommand(input.command)
      if (rewritten !== input.command) input.command = rewritten
    })

    await ctx.command.transform((editor) => {
      editor.add({
        name: "rtk",
        description: "rtk integration status and token savings",
        execute: async ({ sessionID, prompt }: { sessionID: string; prompt: { text: string } }) => {
          const raw = (prompt?.text ?? "").trim().toLowerCase()
          const arg = raw === "" || raw === "status" ? "status" : raw.split(/\s+/)[0]

          switch (arg) {
            case "saved":
            case "stats": {
              const data: SavingsData = await engine.savings()
              await present(ctx, sessionID, formatSavings(data))
              break
            }
            case "on": {
              engine.setEnabled(true)
              await present(ctx, sessionID, "rtk rewriting ON. Commands route through rtk again.")
              break
            }
            case "off": {
              engine.setEnabled(false)
              await present(
                ctx,
                sessionID,
                "rtk rewriting OFF for this session. Commands run raw until /rtk on.",
              )
              break
            }
            case "status": {
              await present(ctx, sessionID, engine.statusText())
              break
            }
            default: {
              await present(ctx, sessionID, "Usage: /rtk saved | status | on | off")
              break
            }
          }
        },
      })
    })

    return () => events.abort()
  },
})
