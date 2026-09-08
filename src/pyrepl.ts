import type { Plugin, PluginModule, ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { fileURLToPath } from "node:url"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import type { Readable, Writable } from "node:stream"

function envInt(name: string, fallback: number, minimum = 1): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n >= minimum ? Math.floor(n) : fallback
}

const SERVER_FILE = fileURLToPath(new URL("./pyrepl_server.py", import.meta.url))
const DEFAULT_TIMEOUT_S = envInt("PYREPL_TIMEOUT_S", 30)
const PREVIEW_LINES = envInt("PYREPL_PREVIEW_LINES", 100)
const PREVIEW_HEAD = envInt("PYREPL_PREVIEW_HEAD", 1000)
const PREVIEW_TAIL = envInt("PYREPL_PREVIEW_TAIL", 2500)
const WAIT_GRACE_MS = envInt("PYREPL_WAIT_GRACE_MS", 15000)
const RPC_TIMEOUT_MS = envInt("PYREPL_RPC_TIMEOUT_MS", 15000)
// Notify the agent inside its own session when a background task finishes,
// so it wakes up on its own instead of relying on manual pyrepl_read polls.
const NOTIFY_AGENT = (process.env.PYREPL_NOTIFY_AGENT ?? "1").trim() !== "0"
const NOTIFY_POLL_MS = envInt("PYREPL_NOTIFY_POLL_MS", 5000)
// Interim progress cadence for long tasks (seconds, 0 = off). Per-exec
// progress_s overrides it; interim notices never dump output.
const NOTIFY_PROGRESS_S = envInt("PYREPL_NOTIFY_PROGRESS_S", 0, 0)

// Shared guidance appended to every tool description: the plugin has no
// plugin-level description field, so cross-tool rules ride on each tool.
// Kept terse: tool outputs are read by the agent, not humans.
const GUIDE =
  " Single-flight: never call exec/init/reset in parallel;" +
  " a second exec returns busy (read or interrupt the running task, then retry, or exec with preempt=true);" +
  " init with a different bin kills the running task." +
  " Prefer define-once/call-many, print sparingly, set timeout_s per attempt, reset when switching problems."

type RpcPending = {
  resolve: (value: TaskResponse) => void
  reject: (err: Error) => void
}

type TaskLine = {
  stream: string
  line: string
}

type TaskError = {
  type: string
  message: string
  traceback?: string
}

// One shape for every task-related RPC response (execute/read/interrupt).
// Optional fields because each op fills a different subset.
type TaskResponse = {
  status: string
  task_id: string
  n?: number
  done?: boolean
  elapsed_ms?: number
  cpu_ms?: number
  alloc_bytes?: number
  peak_growth_bytes?: number
  vars?: number
  mem_limit_mb?: number
  mem_warn?: string
  preempted?: { task_id: string; status: string }
  output_bytes?: number
  output_lines?: number
  lines?: TaskLine[]
  line_count?: number
  truncated_lines?: number
  orphan_new?: number
  orphan_truncated_lines?: number
  result_preview?: string
  result_chars?: number
  result_truncated?: boolean
  result_full?: string | null
  error?: TaskError
  message?: string
}

type TaskListEntry = {
  task_id: string
  n: number
  task_status: string
  elapsed_ms?: number
  output_lines?: number
  output_bytes?: number
  error_type?: string
}

type ProcSnapshot = {
  vars?: number
  cpu_total_ms?: number
  rss_bytes?: number
  peak_rss_bytes?: number
}

type ServerLimits = {
  mem_limit_mb: number
  mem_enforced: boolean
  cpu_limit_s: number
  cpu_enforced: boolean
  nproc_limit: number
  nproc_enforced: boolean
  reason?: string | null
}

type TaskListResponse = {
  status: string
  tasks?: TaskListEntry[]
  proc?: ProcSnapshot
  limits?: ServerLimits
}

type PingResponse = {
  status: string
  version?: string
  python?: string
  limits?: ServerLimits
  proc?: ProcSnapshot
}

type Session = {
  bin: string
  version: string
  proc: ChildProcess
  writer: Writable
  nextId: number
  taskSeq: number
  pending: Map<number, RpcPending>
  buffer: string
  decoder: TextDecoder
  dead: boolean
  exitCode: number | null
  stderrTail: string
  freshPending: boolean
  execCount: number
  limits: ServerLimits | null
  // Bumped on every reset: waiters armed before the reset exit silently
  // instead of watching a recycled task id.
  resetSeq: number
  // Task ids whose final output already reached the agent inline (foreground
  // exec/read/interrupt): no wake-up prompt needed. Task ids already pushed
  // via session.prompt: notify-once, prevents idle->prompt->idle loops.
  consumed: Set<string>
  notified: Set<string>
}

const sessions = new Map<string, Session>()
// Background tasks whose wake-up prompt failed to admit (e.g. session
// gone): retried on the next session.idle event. Values carry the agent
// so the retry wakes up as the same agent.
const pendingNotify = new Map<string, Map<string, string | undefined>>()

// Minimal client surface used for agent wake-ups (full SDK client in prod).
type NotifyClient = {
  session: {
    promptAsync: (opts: {
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string; synthetic?: boolean }>; agent?: string }
    }) => Promise<unknown>
  }
}

function isTerminalTaskStatus(status: string | undefined): boolean {
  return status !== undefined && status !== "running"
}

async function existsExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function probePython(bin: string): Promise<{ ok: boolean; version: string }> {
  return new Promise((resolve) => {
    let proc: ChildProcess
    try {
      proc = spawn(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] })
    } catch {
      resolve({ ok: false, version: "" })
      return
    }
    let out = ""
    let err = ""
    proc.stdout?.on("data", (chunk: unknown) => {
      out += String(chunk)
    })
    proc.stderr?.on("data", (chunk: unknown) => {
      err += String(chunk)
    })
    proc.on("error", () => resolve({ ok: false, version: "" }))
    proc.on("exit", (code) => {
      if (code !== 0) resolve({ ok: false, version: "" })
      else resolve({ ok: true, version: (out + err).trim().split("\n")[0] ?? bin })
    })
  })
}

async function resolveBin(explicit: string | undefined, ctx: ToolContext): Promise<string> {
  if (explicit?.trim()) return explicit.trim()
  if (process.env.PYREPL_PYTHON?.trim()) return process.env.PYREPL_PYTHON.trim()
  for (const root of [ctx.worktree, ctx.directory]) {
    if (!root) continue
    const unix = path.join(root, ".venv", "bin", "python")
    if (await existsExecutable(unix)) return unix
    const win = path.join(root, ".venv", "Scripts", "python.exe")
    if (await existsExecutable(win)) return win
  }
  return "python3"
}

function drainStderr(session: Session, stderr: Readable | null) {
  if (!stderr) return
  ;(async () => {
    const decoder = new TextDecoder()
    try {
      for await (const chunk of stderr) {
        session.stderrTail = (session.stderrTail + decoder.decode(chunk, { stream: true })).slice(-4096)
      }
    } catch {
    }
  })()
}

function handleLine(session: Session, line: string) {
  if (!line.trim()) return
  let msg: { id?: number } & Partial<TaskResponse>
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.id === undefined) return
  const pend = session.pending.get(msg.id)
  if (pend) {
    session.pending.delete(msg.id)
    pend.resolve(msg as TaskResponse)
  }
}

function pumpStdout(session: Session, stdout: Readable | null) {
  if (!stdout) return
  ;(async () => {
    try {
      for await (const chunk of stdout) {
        session.buffer += session.decoder.decode(chunk, { stream: true })
        let idx: number
        while ((idx = session.buffer.indexOf("\n")) >= 0) {
          handleLine(session, session.buffer.slice(0, idx))
          session.buffer = session.buffer.slice(idx + 1)
        }
      }
    } catch {
    }
    for (const [, pend] of session.pending) {
      pend.reject(new Error("repl server closed stdout"))
    }
    session.pending.clear()
  })()
}

function spawnServerProcess(bin: string): { proc: ChildProcess; exited: Promise<number> } {
  const proc = spawn(bin, [SERVER_FILE], { stdio: ["pipe", "pipe", "pipe"] })
  const exited = new Promise<number>((resolve) => {
    proc.on("error", () => resolve(-1))
    proc.on("exit", (code) => resolve(code ?? -1))
  })
  return { proc, exited }
}

async function spawnSession(bin: string, version: string): Promise<Session> {
  const { proc, exited } = spawnServerProcess(bin)
  const stdin = proc.stdin
  if (!stdin) {
    proc.kill("SIGKILL")
    throw new Error(`repl server has no stdin (bin=${bin})`)
  }
  const session: Session = {
    bin,
    version,
    proc,
    writer: stdin,
    nextId: 1,
    taskSeq: 0,
    pending: new Map(),
    buffer: "",
    decoder: new TextDecoder(),
    dead: false,
    exitCode: null,
    stderrTail: "",
    freshPending: true,
    execCount: 0,
    limits: null,
    resetSeq: 0,
    consumed: new Set(),
    notified: new Set(),
  }
  drainStderr(session, proc.stderr)
  pumpStdout(session, proc.stdout)
  exited.then((code) => {
    session.dead = true
    session.exitCode = code
  })
  const pong = await rpc<PingResponse>(session, { op: "ping" }, RPC_TIMEOUT_MS)
  if (pong?.status !== "ok") {
    proc.kill("SIGKILL")
    throw new Error(`repl server failed to start (bin=${bin}): ${session.stderrTail}`)
  }
  session.limits = pong?.limits ?? null
  return session
}

// Write one line, awaiting the stream flush callback so delivery to the
// subprocess stdin pipe is guaranteed before returning.
function writeLine(writer: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    writer.write(line, (err) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve()
    })
  })
}

function rpc<T = TaskResponse>(session: Session, body: Record<string, any>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  const id = session.nextId++
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      session.pending.delete(id)
      signal?.removeEventListener("abort", onAbort)
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error("repl rpc timed out"))
    }, timeoutMs)
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      const err = new Error("repl rpc aborted") as Error & { aborted: boolean }
      err.aborted = true
      reject(err)
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    session.pending.set(id, {
      resolve: (v: TaskResponse) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(v as T)
      },
      reject: (e) => {
        if (settled) return
        settled = true
        cleanup()
        reject(e)
      },
    })
    try {
      void writeLine(session.writer, JSON.stringify({ ...body, id }) + "\n").catch((e: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    } catch (e) {
      if (settled) return
      settled = true
      cleanup()
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

async function rpcAbortable(
  session: Session,
  body: Record<string, any>,
  timeoutMs: number,
  abort: AbortSignal,
): Promise<{ aborted: true; value?: undefined } | { aborted: false; value: TaskResponse }> {
  try {
    return { aborted: false, value: await rpc(session, body, timeoutMs, abort) }
  } catch (e) {
    if (e !== null && typeof e === "object" && (e as { aborted?: boolean }).aborted === true) {
      return { aborted: true }
    }
    throw e
  }
}

function killSession(session: Session) {
  try {
    session.proc.kill("SIGKILL")
  } catch {
  }
}

async function respawnIfDead(
  key: string,
  session: Session,
  context: ToolContext,
): Promise<{ session: Session; note: string }> {
  sessions.delete(key)
  const candidates = [session.bin, await resolveBin(undefined, context)]
  for (const bin of candidates) {
    try {
      const revived = await ensureSession(key, bin)
      return {
        session: revived.session,
        note: `previous REPL process died; restarted on ${revived.session.bin}, all state lost`,
      }
    } catch {
      sessions.delete(key)
    }
  }
  throw new Error(`REPL keeps dying on startup (tried ${candidates.join(", ")}); check the interpreter`)
}

function consumeFreshNote(
  session: Session,
  note: string | null,
  reset: boolean | undefined,
): string | null {
  const wasFresh = session.freshPending
  session.freshPending = false
  if (!wasFresh || reset) return null
  return note ?? `fresh REPL session on ${session.bin}; state is new and is lost when opencode closes`
}

async function ensureSession(key: string, bin: string): Promise<{ session: Session; note: string | null }> {
  const existing = sessions.get(key)
  if (existing && !existing.dead && existing.bin === bin) {
    return { session: existing, note: null }
  }
  if (existing) killSession(existing)
  const probe = await probePython(bin)
  if (!probe.ok) {
    throw new Error(
      `python interpreter not usable: ${bin}. Pass a valid bin_path to pyrepl_init (e.g. /usr/bin/python3 or <venv>/bin/python), or set PYREPL_PYTHON.`,
    )
  }
  const session = await spawnSession(bin, probe.version)
  sessions.set(key, session)
  let note = `fresh REPL session on ${bin} (${probe.version}); state is new and is lost when opencode closes`
  const lim = formatLimitNote(session.limits)
  if (lim) note += `; ${lim}`
  return { session, note }
}

function formatCap(
  label: string,
  unit: string,
  value: number,
  enforced: boolean,
  reason?: string | null,
): string | null {
  if (value <= 0) return null
  const state = enforced ? "enforced" : `requested,unenforced(${reason ?? "platform"}:${label})`
  return `${label}=${value}${unit} ${state}`
}

function formatLimitNote(limits: ServerLimits | null): string | null {
  if (!limits) return null
  const parts = [
    formatCap("mem_limit", "MB", limits.mem_limit_mb, limits.mem_enforced, limits.reason),
    formatCap("cpu_limit", "s", limits.cpu_limit_s, limits.cpu_enforced, limits.reason),
  ].filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join(" ") : null
}

// Millis with sub-ms precision (server sends floats); integers stay bare.
function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "?"
  return `${Number.isInteger(ms) ? ms : ms.toFixed(1)}ms`
}

// Unsigned magnitude; callers add their own sign when needed.
function fmtSize(bytes: number): string {
  const abs = Math.abs(bytes)
  if (abs >= 1024 ** 3) return `${(abs / 1024 ** 3).toFixed(1)}GB`
  if (abs >= 1024 ** 2) return `${(abs / 1024 ** 2).toFixed(1)}MB`
  if (abs >= 1024) return `${Math.round(abs / 1024)}KB`
  return `${abs}B`
}

// Single machine-readable resource line appended to every task output.
// Always present; fields omitted when the platform cannot measure them.
function formatResources(res: TaskResponse): string {
  const parts: string[] = [`wall=${fmtMs(res.elapsed_ms)}`]
  if (res.cpu_ms !== undefined) parts.push(`cpu=${fmtMs(res.cpu_ms)}`)
  if (res.alloc_bytes !== undefined) {
    const a = res.alloc_bytes
    parts.push(`alloc=${a < 0 ? "-" : a > 0 ? "+" : ""}${fmtSize(a)}`)
  }
  if (res.peak_growth_bytes !== undefined) {
    const growth = res.peak_growth_bytes
    const sign = growth < 0 ? "-" : growth > 0 ? "+" : ""
    let peak = `peak=${sign}${fmtSize(growth)}`
    if ((res.mem_limit_mb ?? 0) > 0) peak += `/${res.mem_limit_mb}MB`
    parts.push(peak)
  }
  if (res.vars !== undefined) parts.push(`vars=${res.vars}`)
  return `[resources: ${parts.join(" ")}]`
}

function formatWarn(res: TaskResponse): string[] {
  return res.mem_warn ? [`[warn: ${res.mem_warn}]`] : []
}

function formatLines(
  lines: Array<{ stream: string; line: string }>,
  label: string,
): string {
  if (lines.length === 0) return ""
  const stdout = lines.filter((l) => l.stream === "stdout").map((l) => l.line)
  const stderr = lines.filter((l) => l.stream === "stderr").map((l) => l.line)
  const parts: string[] = []
  if (stdout.length > 0) parts.push(`${label} stdout:\n${stdout.join("\n")}`)
  if (stderr.length > 0) parts.push(`${label} stderr:\n${stderr.join("\n")}`)
  return parts.join("\n")
}

function truncatePreview(text: string): { text: string; cut: boolean } {
  // Char budget first: head+tail on the FULL text so the end (END-MARKERs,
  // final errors) always survives. Line cap only for medium outputs.
  if (text.length > PREVIEW_HEAD + PREVIEW_TAIL) {
    const omitted = text.length - PREVIEW_HEAD - PREVIEW_TAIL
    return {
      text:
        text.slice(0, PREVIEW_HEAD) +
        `\n... [${omitted} chars omitted, END follows] ...\n` +
        text.slice(-PREVIEW_TAIL),
      cut: true,
    }
  }
  const lines = text.split("\n")
  const out = lines.slice(0, PREVIEW_LINES).join("\n")
  return { text: out, cut: lines.length > PREVIEW_LINES }
}

function formatOutputPreview(
  res: TaskResponse,
  label: string,
  cutHint: string,
  extraCut = false,
): string[] {
  const body = formatLines(res.lines ?? [], label)
  if (!body) return []
  const t = truncatePreview(body)
  const out = [t.text]
  if (t.cut || extraCut) out.push(cutHint)
  return out
}

function formatResultValue(res: TaskResponse, fullRef: string): string[] {
  if (res.result_full !== undefined && res.result_full !== null) {
    return [`Out[${res.n}] full (${res.result_chars} chars):`, res.result_full]
  }
  if (res.result_preview === undefined) return []
  const out = [`Out[${res.n}]: ${res.result_preview}`]
  if (res.result_truncated) {
    out.push(`[result ${res.result_chars} chars total, ${fullRef}]`)
  }
  return out
}

function formatErrorLines(res: TaskResponse, withTraceback: boolean): string[] {
  if (!res.error) return []
  const out = [`${res.error.type}: ${res.error.message}`]
  if (withTraceback && res.error.traceback) out.push(res.error.traceback.trim())
  return out
}

function formatDropNotes(res: TaskResponse, includeOrphanDrops: boolean): string[] {
  const out: string[] = []
  if (res.truncated_lines) out.push(`[note: ${res.truncated_lines} oldest lines dropped by ring buffer]`)
  if (includeOrphanDrops && res.orphan_truncated_lines) {
    out.push(`[note: ${res.orphan_truncated_lines} oldest orphan lines dropped by ring buffer]`)
  }
  return out
}

function formatOrphanHint(res: TaskResponse, verb: string): string[] {
  if (!res.orphan_new) return []
  return [
    `[note: ${res.orphan_new} lines of background-thread output arrived during this task; ${verb} with target=orphan]`,
  ]
}

function formatExecResult(res: TaskResponse, session: Session, freshNote: string | null): string {
  const out: string[] = []
  if (freshNote) out.push(`<pyrepl>\n${freshNote}\n<pyrepl>`)
  if (res.status === "running") {
    out.push(`status: running (task ${res.task_id})`)
    out.push(res.message ?? "use pyrepl_read to poll output or pyrepl_interrupt to stop it")
    return out.join("\n")
  }
  if (res.status === "busy") {
    return `status: busy, task ${res.task_id} is still running. ${res.message ?? ""}`.trim()
  }
  if (res.status === "preempt_failed") {
    return `status: preempt_failed, task ${res.task_id} is still running. ${res.message ?? ""}`.trim()
  }
  session.execCount = res.n ?? session.execCount
  if (res.preempted) out.push(`[preempted ${res.preempted.task_id} (${res.preempted.status})]`)
  out.push(
    ...formatOutputPreview(
      res,
      `task ${res.task_id ?? "?"}`,
      `... [output truncated, use pyrepl_read with task_id=${res.task_id}]`,
      (res.line_count ?? 0) > PREVIEW_LINES,
    ),
    ...formatResultValue(res, `use pyrepl_read task_id=${res.task_id} target=result for full`),
    ...formatErrorLines(res, true),
    ...formatDropNotes(res, false),
    ...formatOrphanHint(res, "read with"),
    ...formatWarn(res),
    formatResources(res),
  )
  // formatResources always appends one line, so emptiness is measured
  // against the content above it (plus optional fresh/preempted notes).
  const contentLines = out.length - 1 - (freshNote ? 1 : 0) - (res.preempted ? 1 : 0)
  if (contentLines === 0) out.splice(out.length - 1, 0, "(no output)")
  return out.join("\n")
}

function extractSessionId(props: Record<string, any>): string | undefined {
  const id: unknown = props.info?.id ?? props.sessionID ?? props.sessionId ?? props.id
  return typeof id === "string" ? id : undefined
}

// Short wake-up: single task id plus cost facts, no output dump. The agent
// pulls the output itself with pyrepl_read.
function formatCompletionNotice(taskId: string, res: TaskResponse): string {
  const out = [
    `background task done: task_id=${taskId}, status=${res.status}, elapsed=${res.elapsed_ms ?? "?"}ms, output=${res.output_lines ?? "?"} lines / ${res.output_bytes ?? "?"} bytes`,
  ]
  if (res.error) out.push(`${res.error.type}: ${res.error.message}`)
  out.push(`Use pyrepl_read task_id=${taskId} for the full output.`)
  return `<pyrepl>\n${out.join("\n")}\n<pyrepl>`
}

// Push a prebuilt text into the agent's session. promptAsync admits the
// message even mid-turn (the running turn picks it up next step); on
// admission failure park it for retry on the next session.idle event.
// Returns true when the message was admitted.
async function pushText(
  client: NotifyClient,
  key: string,
  taskId: string,
  agent: string | undefined,
  text: string,
  markNotified = true,
): Promise<boolean> {
  try {
    await client.session.promptAsync({
      path: { id: key },
      body: {
        parts: [{ type: "text", text, synthetic: true }],
        ...(agent ? { agent } : {}),
      },
    })
    if (markNotified) sessions.get(key)?.notified.add(taskId)
    return true
  } catch {
    let set = pendingNotify.get(key)
    if (!set) {
      set = new Map()
      pendingNotify.set(key, set)
    }
    set.set(taskId, agent)
    return false
  }
}

function formatDeathNotice(taskId: string): string {
  return `<pyrepl>\ntask ${taskId} lost: REPL server died, state lost. Re-run pyrepl_exec to respawn fresh.\n<pyrepl>`
}

function formatLostNotice(taskId: string): string {
  return `<pyrepl>\ntask ${taskId} lost: no longer on server (registry evicted or cleared). Output unavailable.\n<pyrepl>`
}

// Notify that a background task finished. The parked queue stores only the
// agent per task: a parked task whose session is dead by flush time is
// reported as lost instead of completed.
async function deliverCompletion(
  client: NotifyClient,
  key: string,
  taskId: string,
  agent: string | undefined,
): Promise<void> {
  const session = sessions.get(key)
  if (!session || session.dead) {
    await pushText(client, key, taskId, agent, formatDeathNotice(taskId))
    return
  }
  if (session.consumed.has(taskId) || session.notified.has(taskId)) return
  try {
    const res = await rpc(
      session,
      { op: "read", task_id: taskId, offset: 0, limit: 200, grep: null, target: "combined", tail_lines: null },
      RPC_TIMEOUT_MS,
    )
    if (res?.status === "not_found") {
      await pushText(client, key, taskId, agent, formatLostNotice(taskId))
      return
    }
    if (res?.status === "error") return
    // A parked entry resolved while the task still runs (e.g. a failed
    // interim notice): the active waiter owns completion, drop the park.
    if (!isTerminalTaskStatus(res.status)) return
    await pushText(client, key, taskId, agent, formatCompletionNotice(taskId, res))
  } catch {
    let set = pendingNotify.get(key)
    if (!set) {
      set = new Map()
      pendingNotify.set(key, set)
    }
    set.set(taskId, agent)
  }
}

function formatProgressNotice(taskId: string, t: TaskListEntry): string {
  return (
    `<pyrepl>\ntask ${taskId} still running: wall=${fmtMs(t.elapsed_ms)} ` +
    `out=${t.output_lines ?? 0}lines/${fmtSize(t.output_bytes ?? 0)}. ` +
    `pyrepl_read task_id=${taskId} tail_lines=20 for latest.\n<pyrepl>`
  )
}

// Fire-and-forget waiter armed when exec returns a running task. Exits
// silently when the output already reached the agent another way, or when
// the session was replaced/reset under it (generation guard: never watch
// a recycled task id).
async function notifyWhenDone(
  client: NotifyClient,
  key: string,
  taskId: string,
  agent: string | undefined,
  progressS = 0,
): Promise<void> {
  const armed = sessions.get(key)
  const armedSeq = armed?.resetSeq ?? -1
  const cadence = Number.isFinite(progressS) && progressS > 0 ? progressS : 0
  let nextProgress = cadence > 0 ? Date.now() + cadence * 1000 : 0
  try {
    for (;;) {
      await new Promise((res) => setTimeout(res, NOTIFY_POLL_MS))
      const session = sessions.get(key)
      if (!session || session !== armed || session.resetSeq !== armedSeq) return
      if (session.consumed.has(taskId) || session.notified.has(taskId)) return
      if (session.dead) {
        await deliverCompletion(client, key, taskId, agent)
        return
      }
      let found: TaskListEntry | undefined
      try {
        const res = await rpc<TaskListResponse>(session, { op: "list" }, RPC_TIMEOUT_MS)
        found = res?.tasks?.find((t) => t.task_id === taskId)
      } catch {
        return
      }
      if (!found || isTerminalTaskStatus(found.task_status)) break
      if (nextProgress > 0 && Date.now() >= nextProgress) {
        nextProgress += cadence * 1000
        // Interim notice: never marks notified, completion still fires.
        await pushText(client, key, taskId, agent, formatProgressNotice(taskId, found), false)
      }
    }
    await deliverCompletion(client, key, taskId, agent)
  } catch {
  }
}

async function flushPendingNotify(client: NotifyClient, key: string): Promise<void> {
  const set = pendingNotify.get(key)
  if (!set || set.size === 0) return
  pendingNotify.delete(key)
  if (!sessions.get(key)) return
  for (const [taskId, agent] of set) await deliverCompletion(client, key, taskId, agent)
}

function formatTaskLine(t: TaskListEntry, dash: boolean): string {
  const parts = [`${t.task_id}: ${t.task_status}`, `wall=${fmtMs(t.elapsed_ms)}`]
  if ((t.output_lines ?? 0) > 0 || t.task_status === "running") {
    parts.push(`out=${t.output_lines ?? 0}lines/${fmtSize(t.output_bytes ?? 0)}`)
  }
  if (t.error_type) parts.push(`err=${t.error_type}`)
  return `${dash ? "- " : "task "}${parts.join(" ")}`
}

function formatLimitsLine(limits: ServerLimits | null | undefined): string[] {
  if (!limits) return []
  const mem = formatCap("mem", "MB", limits.mem_limit_mb, limits.mem_enforced, limits.reason) ?? "mem=unlimited"
  const cpu = formatCap("cpu", "s", limits.cpu_limit_s, limits.cpu_enforced, limits.reason) ?? "cpu=unlimited"
  const nproc =
    (limits.nproc_limit ?? 0) > 0
      ? ` ${formatCap("nproc", "", limits.nproc_limit, limits.nproc_enforced ?? false, limits.reason) ?? ""}`
      : ""
  return [`limits: ${mem} ${cpu}${nproc}`]
}

function formatProcLine(proc: ProcSnapshot | null | undefined): string[] {
  if (!proc) return []
  const parts: string[] = []
  if (proc.rss_bytes !== undefined) parts.push(`rss=${fmtSize(proc.rss_bytes)}`)
  if (proc.peak_rss_bytes !== undefined) parts.push(`peak=${fmtSize(proc.peak_rss_bytes)}`)
  if (proc.cpu_total_ms !== undefined) parts.push(`cpu_total=${fmtMs(proc.cpu_total_ms)}`)
  return parts.length > 0 ? [`proc: ${parts.join(" ")}`] : []
}

// Clamp user seconds into a sane range so a NaN/Inf/negative can never
// wedge an RPC wait on either side of the protocol.
function clampWaitS(v: number | undefined): number {
  if (!Number.isFinite(v ?? NaN)) return 5
  return Math.min(300, Math.max(1, Math.floor(v as number)))
}

export const PyReplPlugin: Plugin = async (ctx) => {
  const client = (ctx?.client ?? null) as NotifyClient | null
  const canNotify = NOTIFY_AGENT && client !== null
  return {
    event: async (input: { event: unknown }) => {
      const event = input.event as { type?: string; properties?: Record<string, any> }
      if (event?.type === "session.deleted") {
        const id = extractSessionId(event.properties ?? {})
        if (id === undefined) return
        const session = sessions.get(id)
        if (session) {
          killSession(session)
          sessions.delete(id)
        }
        pendingNotify.delete(id)
        return
      }
      // Retry wake-up prompts that failed while the session was busy.
      if (event?.type !== "session.idle" || !canNotify) return
      const id = extractSessionId(event.properties ?? {})
      if (id === undefined) return
      await flushPendingNotify(client, id)
    },
    tool: {
      pyrepl_init: tool({
        description:
          "Initialize the persistent Python REPL for this session with a chosen interpreter. Optional; pyrepl_exec auto-initializes with auto-detected python if you skip this. Use when you need a specific venv or global python (like VSCode interpreter picker). WARNING: init with a different interpreter kills any running task immediately and all state is lost." +
          GUIDE,
        args: {
          bin_path: tool.schema
            .string()
            .optional()
            .describe("Python interpreter path, e.g. /usr/bin/python3 or /proj/.venv/bin/python. If omitted: PYREPL_PYTHON env, then .venv in worktree/directory, then python3."),
        },
        async execute(args, context: ToolContext) {
          context.metadata({ title: "pyrepl init" })
          const key = context.sessionID
          const bin = await resolveBin(args.bin_path ?? undefined, context)
          const existing = sessions.get(key)
          if (existing && !existing.dead && existing.bin === bin) {
            return `REPL already running on ${bin} (${existing.version}). State preserved, exec count ${existing.execCount}.`
          }
          const { session } = await ensureSession(key, bin)
          return `REPL ready on ${session.bin} (${session.version}). First pyrepl_exec will note it is a fresh session. State is lost when opencode closes.`
        },
      }),

      pyrepl_exec: tool({
        description:
          "Execute Python code in the persistent REPL. Variables, imports and functions survive across calls. Auto-initializes if needed. Set reset=true to wipe state and run this code as the first command in one step. If the task exceeds timeout_s it is NOT killed: exec returns a task_id and the agent is automatically notified in its session on completion (set PYREPL_NOTIFY_AGENT=0 to disable); polling with pyrepl_read stays optional." +
          GUIDE,
        args: {
          code: tool.schema.string().describe("Python source to execute."),
          reset: tool.schema
            .boolean()
            .optional()
            .describe("If true, clear the namespace first and run code as t_1. No fresh-session note is emitted since you asked for the reset."),
          timeout_s: tool.schema
            .number()
            .optional()
            .describe("Seconds to wait synchronously before returning a running task_id (default 30). The task keeps running after timeout; it is NOT killed."),
          preempt: tool.schema
            .boolean()
            .optional()
            .describe("If true and another task is running, interrupt it first and run this code right after. Fails as preempt_failed when the running task ignores the interrupt (native blocking call); re-init to respawn then."),
          progress_s: tool.schema
            .number()
            .optional()
            .describe("Interim still-running notice cadence in seconds for this task (default off). The completion notice still fires separately; notices never dump output."),
        },
        async execute(args, context: ToolContext) {
          context.metadata({ title: "pyrepl exec" })
          const key = context.sessionID
          const timeoutS = args.timeout_s ?? DEFAULT_TIMEOUT_S
          const waitMs = Math.max(100, Math.floor(timeoutS * 1000))
          // Never re-resolve over a live session: the interpreter chosen by
          // pyrepl_init (or the first auto-init) sticks until the process dies.
          const live = sessions.get(key)
          let bin = live && !live.dead ? live.bin : await resolveBin(undefined, context)
          let { session, note } = await ensureSession(key, bin)
          if (session.dead) {
            const revived = await respawnIfDead(key, session, context)
            session = revived.session
            note = revived.note
          }
          const freshNote = consumeFreshNote(session, note, args.reset)
          if (args.reset) {
            try {
              const rr = await rpc(session, { op: "reset" }, RPC_TIMEOUT_MS)
              if (rr?.status === "busy") {
                const busyId = rr?.task_id ? ` (task_id=${rr.task_id})` : ""
                return `reset refused: a task is still running${busyId}. Call pyrepl_interrupt first, then retry with reset=true.`
              }
            } catch (e) {
              killSession(session)
              sessions.delete(key)
              const created = await ensureSession(key, session.bin)
              session = created.session
            }
            session.execCount = 0
            // Task ids restart at t_1 alongside exec numbers (the server
            // drops its registry on reset; busy replies never consume an
            // id, see below), so t_N always means exec #N and Out[N].
            // Forget delivery bookkeeping with them to avoid waking the
            // agent with stale pre-reset output under a recycled id.
            session.taskSeq = 0
            session.resetSeq += 1
            session.consumed.clear()
            session.notified.clear()
            pendingNotify.delete(key)
          }
          session.taskSeq += 1
          const taskId = `t_${session.taskSeq}`
          const outcome = await rpcAbortable(
            session,
            { op: "execute", task_id: taskId, code: args.code, wait_ms: waitMs, preempt: args.preempt ?? false },
            waitMs + WAIT_GRACE_MS,
            context.abort,
          )
          if (outcome.aborted) {
            return `wait aborted by caller; task ${taskId} is still running. Use pyrepl_read to poll it or pyrepl_interrupt to stop it.`
          }
          const res = outcome.value
          if (res?.status === "busy" || res?.status === "preempt_failed") {
            // The server created nothing for these replies, so take the
            // pre-armed id back. t_N then always means exec #N (Out[N]
            // stays the single visible counter).
            session.taskSeq -= 1
          }
          if (args.reset) session.execCount = res?.n ?? 1
          if (res?.status === "running" && res?.task_id) {
            // Background task: wake the agent here on completion so it does
            // not have to poll. The waiter exits silently if the output
            // reaches the agent first via pyrepl_read/pyrepl_interrupt.
            if (res?.preempted) session.consumed.add(res.preempted.task_id)
            const progressS = args.progress_s ?? NOTIFY_PROGRESS_S
            if (canNotify) void notifyWhenDone(client, key, res.task_id, context.agent || undefined, progressS)
            const out = formatExecResult(res, session, freshNote)
            return canNotify
              ? `${out}\n<pyrepl>\nI will notify you in this session when task ${res.task_id} finishes; polling with pyrepl_read is optional\n<pyrepl>`
              : out
          }
          if (res?.task_id) session.consumed.add(res.task_id)
          // A preempted task ended without its output reaching the agent
          // inline; suppress the stale wake-up its old waiter may deliver.
          if (res?.preempted) session.consumed.add(res.preempted.task_id)
          return formatExecResult(res, session, freshNote)
        },
      }),

      pyrepl_read: tool({
        description:
          "Read buffered output of a REPL task. Use for tasks that timed out (status running) or outputs that were truncated. Supports line ranges, tail mode, stream selection and regex grep." +
          GUIDE,
        args: {
          task_id: tool.schema.string().describe("Task id returned by pyrepl_exec."),
          offset: tool.schema.number().optional().describe("First line to return (default 0). Ignored with tail_lines."),
          limit: tool.schema.number().optional().describe("Max lines to return (default 200)."),
          grep: tool.schema.string().optional().describe("Regex filter applied to lines before pagination."),
          target: tool.schema
            .enum(["stdout", "stderr", "combined", "result", "orphan"])
            .optional()
            .describe(
              "Which stream to read (default combined). result returns the full expression value; orphan returns late output from background threads.",
            ),
          tail_lines: tool.schema.number().optional().describe("Return only the last N lines."),
        },
        async execute(args, context: ToolContext) {
          context.metadata({ title: `pyrepl read ${args.task_id}` })
          const session = sessions.get(context.sessionID)
          if (!session || session.dead) return `no REPL session active (task ${args.task_id} unknown; sessions do not survive opencode restarts)`
          const res = await rpc(
            session,
            {
              op: "read",
              task_id: args.task_id,
              offset: args.offset ?? 0,
              limit: args.limit ?? 200,
              grep: args.grep ?? null,
              target: args.target ?? "combined",
              tail_lines: args.tail_lines ?? null,
            },
            RPC_TIMEOUT_MS,
          )
          if (res?.status === "not_found") return `unknown task ${args.task_id}`
          if (res?.status === "error") return `read error: ${res.message ?? "unknown"}`
          if (isTerminalTaskStatus(res.status) && res.task_id) session.consumed.add(res.task_id)
          const out: string[] = [`task ${res.task_id}: ${res.status}`]
          out.push(...formatResultValue(res, "re-read with target=result for full"))
          out.push(...formatErrorLines(res, true))
          const preview = formatOutputPreview(res, "output", `... [preview truncated, re-read with offset/limit]`)
          if (preview.length > 0) out.push(...preview)
          else if (res.status === "running") out.push("(no output yet)")
          out.push(...formatDropNotes(res, true))
          out.push(...formatOrphanHint(res, "re-read with"))
          out.push(...formatWarn(res))
          out.push(formatResources(res))
          return out.join("\n")
        },
      }),

      pyrepl_status: tool({
        description:
          "Show live REPL session state without executing code: interpreter, exec count, resource limits, process counters, running tasks. Task history needs limit or filter params, otherwise only live info is shown. Use to re-orient after compaction or when unsure what is running." +
          GUIDE,
        args: {
          task_id: tool.schema
            .string()
            .optional()
            .describe("Check one task only instead of the whole session."),
          limit: tool.schema
            .number()
            .optional()
            .describe("Show this many recent tasks (history). Omit for live info only."),
          filter: tool.schema
            .enum(["all", "running", "failed"])
            .optional()
            .describe("History filter: all, running only, or failed (error+interrupted). Implies limit=10 when limit is omitted."),
        },
        async execute(args, context: ToolContext) {
          context.metadata({ title: "pyrepl status" })
          const session = sessions.get(context.sessionID)
          if (!session || session.dead) {
            return `no REPL session active. pyrepl_exec will auto-initialize one; sessions do not survive opencode restarts.`
          }
          let list: TaskListResponse
          try {
            list = await rpc<TaskListResponse>(session, { op: "list" }, RPC_TIMEOUT_MS)
          } catch {
            return `REPL on ${session.bin} (${session.version}) is not responding. Re-run pyrepl_init to respawn.`
          }
          const tasks = list?.tasks ?? []
          if (args.task_id) {
            const found = tasks.find((t) => t.task_id === args.task_id)
            if (!found) return `unknown task ${args.task_id}`
            return formatTaskLine(found, false)
          }
          const out = [
            `REPL on ${session.bin} (${session.version}), exec count ${session.execCount}` +
              (list?.proc?.vars !== undefined ? `, vars=${list.proc.vars}` : ""),
            ...formatLimitsLine(list?.limits ?? session.limits),
            ...formatProcLine(list?.proc),
          ]
          const running = tasks.filter((t) => t.task_status === "running")
          for (const t of running) out.push(`running: ${formatTaskLine(t, false)}`)
          // History is opt-in: without limit/filter the agent gets live
          // info only, keeping bg-status checks cheap.
  const wantHistory = args.limit !== undefined || args.filter !== undefined
  if (!wantHistory) return out.join("\n")
  const rawLimit = args.limit ?? 10
  const n = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 10
          let hist = tasks
          if (args.filter === "running") hist = hist.filter((t) => t.task_status === "running")
          else if (args.filter === "failed") {
            hist = hist.filter((t) => t.task_status === "error" || t.task_status === "interrupted")
          }
          hist = hist.slice(-n)
          if (hist.length === 0) {
            out.push("no matching tasks")
          } else {
            out.push(`recent (last ${hist.length}):`)
            for (const t of hist) out.push(formatTaskLine(t, true))
          }
          return out.join("\n")
        },
      }),

      pyrepl_interrupt: tool({
        description:
          "Interrupt a running REPL task by injecting an exception into its thread. Returns partial output. The session survives; only that task stops. Native blocking calls (sleep, solvers, locks) ignore it: re-init via pyrepl_init with the same bin_path to respawn." +
          GUIDE,
        args: {
          task_id: tool.schema.string().describe("Running task id from pyrepl_exec."),
          wait_s: tool.schema
            .number()
            .optional()
            .describe("Seconds to wait for the task to stop after injection (default 5). Longer for tasks with heavy cleanup."),
        },
        async execute(args, context: ToolContext) {
          context.metadata({ title: `pyrepl interrupt ${args.task_id}` })
          const session = sessions.get(context.sessionID)
          if (!session || session.dead) return `no REPL session active (task ${args.task_id} unknown)`
          const res = await rpc(session, { op: "interrupt", task_id: args.task_id, wait_s: clampWaitS(args.wait_s) }, RPC_TIMEOUT_MS)
          if (res?.status === "not_found") return `unknown task ${args.task_id}`
          if (res?.status === "error") return `interrupt error: ${res.message ?? "unknown"}; re-init via pyrepl_init with the same bin_path to respawn`
          // The agent is present and got the partial output inline; no
          // wake-up needed if the waiter has not fired yet.
          if (res?.task_id) session.consumed.add(res.task_id)
          const out: string[] = [`task ${res.task_id}: ${res.status}`]
          if (res.message) out.push(res.message)
          if (res.status === "running") {
            out.push("[interrupt pending: takes effect when the native call returns; re-init to kill immediately]")
          }
          out.push(
            ...formatOutputPreview(
              res,
              "partial output",
              `... [preview truncated, use pyrepl_read with task_id=${res.task_id}]`,
            ),
          )
          out.push(...formatErrorLines(res, false))
          out.push(...formatWarn(res))
          out.push(formatResources(res))
          return out.join("\n")
        },
      }),
    },
  }
}

// Default export for package-style loading (opencode.json `plugin` field,
// local or npm). Path plugins must export an id.
const PyReplPluginModule: PluginModule = {
  id: "pyrepl",
  server: PyReplPlugin,
}
export default PyReplPluginModule
