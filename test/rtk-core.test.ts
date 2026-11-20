/**
 * Smoke tests for the host-independent core: a fake `rtk` executable, no
 * network, no real rtk, no OpenCode host.
 *
 * Run with:  bun test/rtk-core.test.ts
 */

import assert from "node:assert/strict"
import {
  RtkEngine,
  ExecFn,
  ExecResult,
  Totals,
  parseGain,
  parseSemver,
  splitCommandSegments,
} from "../src/rtk-core"

interface FakeRtk {
  version?: string
  rewrites?: Record<string, string>
  gain?: Totals
}

function makeExec(rtk: FakeRtk): ExecFn {
  return async (cmd: string, args: string[]): Promise<ExecResult> => {
    assert.equal(cmd, "rtk")
    if (args[0] === "--version") {
      if (!rtk.version) return { code: 127, stdout: "", killed: false }
      return { code: 0, stdout: `${rtk.version}\n`, killed: false }
    }
    if (args[0] === "rewrite") {
      const raw = args.slice(1).join(" ")
      const rewritten = rtk.rewrites?.[raw]
      if (rewritten === undefined) return { code: 1, stdout: "", killed: false }
      return { code: 0, stdout: `${rewritten}\n`, killed: false }
    }
    if (args[0] === "gain") {
      const g = rtk.gain!
      return {
        code: 0,
        stdout: JSON.stringify({
          summary: {
            total_commands: g.commands,
            total_input: g.input,
            total_output: g.output,
            total_saved: g.saved,
          },
        }),
        killed: false,
      }
    }
    return { code: 1, stdout: "", killed: false }
  }
}

let passed = 0
let failed = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    passed++
  } catch (err) {
    failed++
    console.error(`FAIL: ${name}`, err)
  }
}

const gainA: Totals = { commands: 100, input: 10000, output: 3000, saved: 7000 }
const rtk: FakeRtk = {
  version: "rtk 0.50.0",
  rewrites: { "git status": "rtk git status", "ls -la": "rtk ls -la" },
  gain: gainA,
}
const engine = new RtkEngine(makeExec(rtk))

await check("version parsed", () => assert.deepEqual(parseSemver("rtk 0.50.0"), [0, 50, 0]))
await check("bad version returns null", () => assert.equal(parseSemver("nope"), null))
await check("parseGain reads summary", () =>
  assert.deepEqual(parseGain(JSON.stringify({ summary: { total_commands: 1, total_input: 5, total_output: 2, total_saved: 3 } })), {
    commands: 1,
    input: 5,
    output: 2,
    saved: 3,
  }),
)

await engine.init()
await check("rtk detected", () => assert.equal(engine.available, true))
await check("rtk version retained", () => assert.equal(engine.rtkVersion, "0.50.0"))
await engine.onSessionStart()

await check("session snapshot queried gain", async () => assert.ok(engine.snapshot !== null))
await check("rewrites git status", async () => assert.equal(await engine.rewriteBashCommand("git status"), "rtk git status"))
await check("passes echo through", async () => assert.equal(await engine.rewriteBashCommand("echo hello"), "echo hello"))
await check("leaves rtk commands alone", async () => assert.equal(await engine.rewriteBashCommand("rtk ls"), "rtk ls"))

await check("status reports one rewrite", () => assert.match(engine.statusText(), /1 command rewritten/))
await check("status reports version", () => assert.match(engine.statusText(), /0\.50\.0/))

// Savings card: session delta and lifetime totals from rtk's own tracker.
rtk.gain = { commands: 105, input: 15000, output: 4500, saved: 10500 }
const card = await engine.savings()
await check("session delta commands", () => assert.equal(card.session?.commands, 5))
await check("session delta saved", () => assert.equal(card.session?.saved, 3500))
await check("session delta pct 70%", () => assert.ok(Math.abs((card.session?.pct ?? 0) - 0.7) < 1e-9))
await check("lifetime totals", () => assert.equal(card.lifetime?.saved, 10500))
await check("lifetime pct 70%", () => assert.ok(Math.abs((card.lifetime?.pct ?? 0) - 0.7) < 1e-9))
await check("rewrite count in card", () => assert.equal(card.rewrites, 1))

// /rtk off pauses rewriting without touching the count; /rtk on resumes.
engine.setEnabled(false)
await check("off pauses rewriting", async () => assert.equal(await engine.rewriteBashCommand("git status"), "git status"))
engine.setEnabled(true)
await check("on resumes rewriting", async () => assert.equal(await engine.rewriteBashCommand("git status"), "rtk git status"))
await check("rewrites counted across toggle", async () => assert.equal((await engine.savings()).rewrites, 2))

// rtk gain --reset mid-session: negative deltas clamp to zero.
rtk.gain = { commands: 1, input: 10, output: 3, saved: 7 }
const card2 = await engine.savings()
await check("reset clamps session delta to zero", () => assert.equal(card2.session?.saved, 0))

// Multi-line scripts: rtk declines the whole command ($(pwd) is not a
// rewritable construct), so the engine retries line by line.
rtk.rewrites!["uv run pytest -q 2>&1 | tail -n 2"] = "uv run rtk pytest -q 2>&1 | tail -n 2"
const declinedScript = "export PYTHONPATH=$PYTHONPATH:$(pwd)/src\nuv run pytest -q 2>&1 | tail -n 2"
await check(
  "rewrites lines of a declined script",
  async () =>
    assert.equal(
      await engine.rewriteBashCommand(declinedScript),
      "export PYTHONPATH=$PYTHONPATH:$(pwd)/src\nuv run rtk pytest -q 2>&1 | tail -n 2",
    ),
)

// Heredoc bodies are data: never rewritten even when a rule matches.
rtk.rewrites!["uv run pytest -q"] = "uv run rtk pytest -q"
const heredoc = "python3 - <<'PY'\nuv run pytest -q\nPY"
await check("leaves heredoc bodies alone", async () => assert.equal(await engine.rewriteBashCommand(heredoc), heredoc))

// Continuation lines are collapsed into one command, rewritten, emitted as one line.
rtk.rewrites!["cd /x &&  git status"] = "cd /x && rtk git status"
await check(
  "rewrites continued command",
  async () => assert.equal(await engine.rewriteBashCommand("cd /x && \\\ngit status"), "cd /x && rtk git status"),
)

// A single-line command rtk declines still passes through untouched.
await check("single-line decline passes through", async () => assert.equal(await engine.rewriteBashCommand("echo $(date)"), "echo $(date)"))

await check("segment splitter keeps heredoc literal", () => {
  const segments = splitCommandSegments(heredoc)
  assert.equal(segments[1]?.kind, "literal")
})

// Hard kill switch cannot be overridden with `/rtk on`.
const hard = new RtkEngine(makeExec(rtk), { hardDisabled: true })
await hard.init()
await check("hard kill switch blocks rewriting", async () => assert.equal(await hard.rewriteBashCommand("git status"), "git status"))
hard.setEnabled(true)
await check("hard kill switch survives on", async () => assert.equal(await hard.rewriteBashCommand("git status"), "git status"))

// Unavailable rtk: init fails before any rewrite handler would be registered.
const missing = new RtkEngine(makeExec({}))
await check("missing binary disables engine", async () => {
  assert.equal(await missing.init(), false)
  assert.equal(missing.available, false)
})
const ancient = new RtkEngine(makeExec({ version: "rtk 0.10.0" }))
await check("old rtk disables engine", async () => {
  assert.equal(await ancient.init(), false)
  assert.equal(ancient.available, false)
})

console.log(`\n${passed} passed, ${failed} failed`)
process.exitCode = failed === 0 ? 0 : 1
