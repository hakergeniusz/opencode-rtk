/**
 * Pure, host-independent core of the rtk plugin.
 *
 * It deliberately imports neither `@opencode/plugin` nor any pi package: the
 * OpenCode adapter in `index.ts` supplies an `ExecFn`, and the smoke tests
 * supply a fake one. All rewrite policy stays in `rtk rewrite`; this module is
 * a thin delegator, exactly like the original pi extension.
 *
 * `rtk rewrite` exit-code contract:
 *   0 + stdout  Rewrite found   -> mutate command
 *   1           No equivalent  -> pass through unchanged
 *   3 + stdout  Advisory rewrite -> mutate command
 */

export const REWRITE_TIMEOUT_MS = 2_000
export const GAIN_TIMEOUT_MS = 2_000
export const MIN_SUPPORTED_RTK_MINOR = 23

export interface ExecResult {
  code: number
  stdout: string
  killed: boolean
}

export type ExecFn = (
  command: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal },
) => Promise<ExecResult>

/** Totals from `rtk gain --format json`. */
export interface GainSummary {
  total_commands: number
  total_input: number
  total_output: number
  total_saved: number
  avg_savings_pct?: number
}

export interface GainJson {
  summary?: GainSummary
}

export interface Totals {
  commands: number
  input: number
  output: number
  saved: number
}

export interface SavingsData {
  at: string
  /** Commands this plugin actually rewrote during this session. */
  rewrites: number
  /** rtk-reported totals minus the session-start snapshot; null when unavailable. */
  session: { commands: number; saved: number; pct: number | null } | null
  lifetime: { commands: number; saved: number; pct: number | null } | null
}

/** Parse "X.Y.Z" semver, returning [major, minor, patch] or null. */
export function parseSemver(raw: string): [number, number, number] | null {
  const m = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

/** Calls `rtk rewrite`; returns the rewritten command or null (pass through). */
export async function rewriteCommand(
  exec: ExecFn,
  cmd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const result = await exec("rtk", ["rewrite", cmd], { timeout: REWRITE_TIMEOUT_MS, signal })
  if (result.killed) return null
  if (result.code !== 0 && result.code !== 3) return null
  return result.stdout.trim() || null
}

/** One parsed piece of a multi-line command. */
export interface CommandSegment {
  kind: "cmd"
  /** Exact original text, including embedded "\\\n" continuations. */
  raw: string
  /** Continuation-collapsed single line handed to `rtk rewrite`. */
  joined: string
}

export interface LiteralSegment {
  kind: "literal"
  raw: string
}

export type Segment = CommandSegment | LiteralSegment

const HEREDOC_START_RE = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
/** Above this line count the per-line fallback is skipped (pathological input). */
export const MAX_FALLBACK_LINES = 64

function trailingBackslashes(s: string): number {
  let n = 0
  for (let i = s.length - 1; i >= 0 && s[i] === "\\"; i--) n++
  return n
}

/**
 * Split a multi-line command into segments: heredoc bodies and comments stay
 * literal; everything else becomes one segment per logical command, with
 * "\\\n" continuations collapsed so `rtk rewrite` sees a single line.
 */
export function splitCommandSegments(cmd: string): Segment[] {
  const rawLines = cmd.split("\n")
  const segments: Segment[] = []
  const heredocTerminators: string[] = []
  let i = 0
  while (i < rawLines.length) {
    const line = rawLines[i]
    const trimmed = line.trim()
    if (heredocTerminators.length > 0) {
      segments.push({ kind: "literal", raw: line })
      if (trimmed === heredocTerminators[heredocTerminators.length - 1]) heredocTerminators.pop()
      i++
      continue
    }
    if (trimmed === "" || trimmed.startsWith("#")) {
      segments.push({ kind: "literal", raw: line })
      i++
      continue
    }
    let raw = line
    while (i + 1 < rawLines.length && trailingBackslashes(raw) % 2 === 1) {
      i++
      raw += "\n" + rawLines[i]
    }
    const joined = raw.replace(/\\\n\s*/g, " ")
    segments.push({ kind: "cmd", raw, joined })
    HEREDOC_START_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = HEREDOC_START_RE.exec(joined)) !== null) {
      heredocTerminators.push(m[2])
    }
    i++
  }
  return segments
}

/**
 * Rewrite a bash command via `rtk rewrite`. Tries the whole command first;
 * when rtk declines (e.g. the command contains `$(...)`) and the command is
 * multi-line, falls back to rewriting it line by line — heredoc bodies and
 * comments are left untouched, lines rtk cannot rewrite stay verbatim.
 * Returns null when nothing changed (pass through).
 */
export async function rewriteCommandSmart(
  exec: ExecFn,
  cmd: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const whole = await rewriteCommand(exec, cmd, signal)
  if (whole !== null) return whole
  if (!cmd.includes("\n")) return null
  if (cmd.split("\n").length > MAX_FALLBACK_LINES) return null

  const segments = splitCommandSegments(cmd)
  const out: string[] = []
  let changed = false
  for (const seg of segments) {
    if (seg.kind === "literal") {
      out.push(seg.raw)
      continue
    }
    const rewritten = await rewriteCommand(exec, seg.joined, signal)
    if (rewritten !== null && rewritten !== seg.joined) {
      changed = true
      out.push(rewritten)
    } else {
      out.push(seg.raw)
    }
  }
  return changed ? out.join("\n") : null
}

export function parseGain(stdout: string): Totals | null {
  try {
    const json = JSON.parse(stdout) as GainJson
    const s = json.summary
    if (!s || typeof s.total_saved !== "number" || typeof s.total_input !== "number") return null
    return {
      commands: s.total_commands ?? 0,
      input: s.total_input,
      output: s.total_output ?? 0,
      saved: s.total_saved,
    }
  } catch {
    return null
  }
}

/** Difference of two rtk totals; clamps at zero (e.g. after `rtk gain --reset`). */
export function diffTotals(
  current: Totals,
  snapshot: Totals,
): { commands: number; saved: number; pct: number | null } {
  const dInput = Math.max(0, current.input - snapshot.input)
  const dSaved = Math.max(0, current.saved - snapshot.saved)
  const dCommands = Math.max(0, current.commands - snapshot.commands)
  return { commands: dCommands, saved: dSaved, pct: dInput > 0 ? dSaved / dInput : null }
}

export function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US")
}

export function pct(p: number | null | undefined): string {
  return typeof p === "number" ? `${(p * 100).toFixed(1)}%` : "n/a"
}

export interface EngineOptions {
  /** Hard kill switch (`RTK_DISABLED=1` in pi); `/rtk on` cannot override it. */
  hardDisabled?: boolean
}

/**
 * Session-scoped state and behavior. The OpenCode adapter owns one instance;
 * the tests construct one with a fake executor.
 */
export class RtkEngine {
  readonly exec: ExecFn
  readonly hardDisabled: boolean
  enabled: boolean
  rtkVersion: string | undefined
  rewrites = 0
  snapshot: Totals | null = null
  available = false
  unavailableReason: string | undefined

  constructor(exec: ExecFn, options: EngineOptions = {}) {
    this.exec = exec
    this.hardDisabled = options.hardDisabled === true
    this.enabled = !this.hardDisabled
  }

  /** Probe rtk's version. Returns false (and records why) if unusable. */
  async init(): Promise<boolean> {
    const ver = await this.exec("rtk", ["--version"], { timeout: REWRITE_TIMEOUT_MS })
    if (ver.code !== 0) {
      this.unavailableReason = "rtk binary not found in PATH"
      return false
    }
    const versionText = ver.stdout.trim().replace(/^rtk\s+/, "")
    this.rtkVersion = versionText

    const parsed = parseSemver(versionText)
    if (parsed) {
      const [major, minor] = parsed
      if (major === 0 && minor < MIN_SUPPORTED_RTK_MINOR) {
        this.unavailableReason = `rtk ${parsed.join(".")} is too old (need >= 0.23.0)`
        return false
      }
    }
    this.available = true
    return true
  }

  async fetchTotals(): Promise<Totals | null> {
    try {
      const result = await this.exec("rtk", ["gain", "--format", "json"], { timeout: GAIN_TIMEOUT_MS })
      if (result.code !== 0) return null
      return parseGain(result.stdout)
    } catch {
      return null
    }
  }

  /** Reset per-session counters and snapshot rtk's gain tracker. */
  async onSessionStart(): Promise<void> {
    this.rewrites = 0
    this.snapshot = await this.fetchTotals()
  }

  /**
   * Rewrite a bash command in place (via the returned string). Never throws for
   * expected failures and never rewrites an already-rtk command.
   */
  async rewriteBashCommand(command: string, signal?: AbortSignal): Promise<string> {
    try {
      if (typeof command !== "string" || command.trim() === "") return command
      if (command.startsWith("rtk ")) return command
      if (!this.available || !this.enabled || this.hardDisabled) return command

      const rewritten = await rewriteCommandSmart(this.exec, command, signal)
      if (rewritten && rewritten !== command) {
        this.rewrites += 1
        return rewritten
      }
    } catch (err) {
      // Fail open: never block execution on an unexpected error.
      console.warn("[rtk] unexpected error in rewrite handler; passing command through", err)
    }
    return command
  }

  async savings(): Promise<SavingsData> {
    const current = await this.fetchTotals()
    return {
      at: new Date().toISOString(),
      rewrites: this.rewrites,
      session: current && this.snapshot ? diffTotals(current, this.snapshot) : null,
      lifetime: current
        ? {
            commands: current.commands,
            saved: current.saved,
            pct: current.input > 0 ? current.saved / current.input : null,
          }
        : null,
    }
  }

  setEnabled(value: boolean): void {
    this.enabled = value
  }

  statusText(): string {
    return `rtk ${this.rtkVersion ?? "?"} — rewriting ${this.enabled ? "ON" : "OFF"}, ${fmt(this.rewrites)} command${this.rewrites === 1 ? "" : "s"} rewritten this session. /rtk saved | on | off`
  }
}

/** Plain-text rendering of the savings card (no model-facing styling). */
export function formatSavings(data: SavingsData): string {
  const s = data.session
  const l = data.lifetime
  return [
    "⚡ rtk token savings",
    "Basis: rtk's own raw vs. compressed output measurement",
    `This session: ${s ? `${fmt(s.saved)} tokens (${pct(s.pct)}), ${fmt(s.commands)} rtk commands in window` : "snapshot unavailable"}`,
    `Commands rewritten by opencode-rtk: ${data.rewrites}`,
    `rtk lifetime: ${l ? `${fmt(l.saved)} tokens (${pct(l.pct)}), ${fmt(l.commands)} commands` : "unavailable"}`,
  ].join("\n")
}
