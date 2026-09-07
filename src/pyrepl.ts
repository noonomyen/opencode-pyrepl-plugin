import type { Plugin, PluginModule, ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { fileURLToPath } from "node:url"
import { access } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim()
  if (!raw) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

const SERVER_FILE = fileURLToPath(new URL("./pyrepl_server.py", import.meta.url))
const DEFAULT_TIMEOUT_S = envInt("PYREPL_TIMEOUT_S", 30)
const PREVIEW_LINES = envInt("PYREPL_PREVIEW_LINES", 100)
const PREVIEW_HEAD = envInt("PYREPL_PREVIEW_HEAD", 2000)
const PREVIEW_TAIL = envInt("PYREPL_PREVIEW_TAIL", 1500)
const WAIT_GRACE_MS = envInt("PYREPL_WAIT_GRACE_MS", 15000)

type Pending = {
  resolve: (value: any) => void
  reject: (err: Error) => void
}

type Session = {
  bin: string
  version: string
  proc: Bun.Subprocess
  writer: Bun.FileSink
  nextId: number
  taskSeq: number
  pending: Map<number, Pending>
  buffer: string
  decoder: TextDecoder
  dead: boolean
  exitCode: number | null
  stderrTail: string
  freshPending: boolean
  execCount: number
}

const sessions = new Map<string, Session>()

async function existsExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function probePython(bin: string): Promise<{ ok: boolean; version: string }> {
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (code !== 0) return { ok: false, version: "" }
    return { ok: true, version: (out + err).trim().split("\n")[0] ?? bin }
  } catch {
    return { ok: false, version: "" }
  }
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

function drainStderr(session: Session, proc: Bun.Subprocess) {
  if (!proc.stderr || typeof proc.stderr === "number") return
  ;(async () => {
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        session.stderrTail = (session.stderrTail + decoder.decode(value, { stream: true })).slice(-4096)
      }
    } catch {
    } finally {
      reader.releaseLock()
    }
  })()
}

function pumpStdout(session: Session, proc: Bun.Subprocess) {
  if (!proc.stdout || typeof proc.stdout === "number") return
  ;(async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        session.buffer += session.decoder.decode(value, { stream: true })
        let idx: number
        while ((idx = session.buffer.indexOf("\n")) >= 0) {
          const line = session.buffer.slice(0, idx)
          session.buffer = session.buffer.slice(idx + 1)
          if (!line.trim()) continue
          let msg: any
          try {
            msg = JSON.parse(line)
          } catch {
            continue
          }
          const pend = session.pending.get(msg.id)
          if (pend) {
            session.pending.delete(msg.id)
            pend.resolve(msg)
          }
        }
      }
    } catch {
    } finally {
      reader.releaseLock()
    }
    for (const [, pend] of session.pending) {
      pend.reject(new Error("repl server closed stdout"))
    }
    session.pending.clear()
  })()
}

async function spawnSession(bin: string, version: string): Promise<Session> {
  const proc = Bun.spawn([bin, SERVER_FILE], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const session: Session = {
    bin,
    version,
    proc,
    writer: proc.stdin as Bun.FileSink,
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
  }
  drainStderr(session, proc)
  pumpStdout(session, proc)
  proc.exited.then((code) => {
    session.dead = true
    session.exitCode = code
  })
  const pong = await rpc(session, { op: "ping" }, 10000)
  if (pong?.status !== "ok") {
    proc.kill()
    throw new Error(`repl server failed to start (bin=${bin}): ${session.stderrTail}`)
  }
  return session
}

function rpc(session: Session, body: Record<string, any>, timeoutMs: number, signal?: AbortSignal): Promise<any> {
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
      resolve: (v) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(v)
      },
      reject: (e) => {
        if (settled) return
        settled = true
        cleanup()
        reject(e)
      },
    })
    try {
      session.writer.write(JSON.stringify({ ...body, id }) + "\n")
      session.writer.flush()
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
): Promise<{ aborted: boolean; value?: any }> {
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
  return { session, note: `fresh REPL session on ${bin} (${probe.version}); state is new and is lost when opencode closes` }
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

function formatExecResult(res: any, session: Session, freshNote: string | null): string {
  const out: string[] = []
  if (freshNote) out.push(`[pyrepl: ${freshNote}]`)
  if (res.status === "running") {
    out.push(`status: running (task ${res.task_id}, exec #${res.n})`)
    out.push(res.message ?? "use pyrepl_read to poll output or pyrepl_interrupt to stop it")
    return out.join("\n")
  }
  if (res.status === "busy") {
    return `status: busy, task ${res.task_id} is still running. ${res.message ?? ""}`.trim()
  }
  session.execCount = res.n ?? session.execCount
  const body = formatLines(res.lines ?? [], `exec #${res.n ?? "?"}`)
  if (body) {
    const t = truncatePreview(body)
    out.push(t.text)
    if (t.cut || (res.line_count ?? 0) > PREVIEW_LINES) {
      out.push(`... [output truncated, use pyrepl_read with task_id=${res.task_id}]`)
    }
  }
  if (res.result_preview !== undefined) {
    out.push(`Out[${res.n}]: ${res.result_preview}`)
    if (res.result_truncated) {
      out.push(
        `[result ${res.result_chars} chars total, use pyrepl_read task_id=${res.task_id} target=result for full]`,
      )
    }
  }
  if (res.error) {
    out.push(`${res.error.type}: ${res.error.message}`)
    if (res.error.traceback) out.push(res.error.traceback.trim())
  }
  if (res.truncated_lines) out.push(`[note: ${res.truncated_lines} oldest lines dropped by ring buffer]`)
  if (res.orphan_new) {
    out.push(
      `[note: ${res.orphan_new} lines of background-thread output arrived during this task; read with target=orphan]`,
    )
  }
  if (out.length === 0 || (out.length === 1 && freshNote)) out.push("(no output)")
  return out.join("\n")
}

export const PyReplPlugin: Plugin = async (_ctx) => {
  return {
    event: async (input: { event: unknown }) => {
      const event = input.event as { type?: string; properties?: Record<string, any> }
      if (event?.type !== "session.deleted") return
      const props = event.properties ?? {}
      const id: unknown = props.info?.id ?? props.sessionID ?? props.sessionId ?? props.id
      if (typeof id !== "string") return
      const session = sessions.get(id)
      if (session) {
        killSession(session)
        sessions.delete(id)
      }
    },
    tool: {
      pyrepl_init: tool({
        description:
          "Initialize the persistent Python REPL for this session with a chosen interpreter. Optional; pyrepl_exec auto-initializes with auto-detected python if you skip this. Use when you need a specific venv or global python (like VSCode interpreter picker).",
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
          "Execute Python code in the persistent REPL. Variables, imports and functions survive across calls. Auto-initializes if needed. Set reset=true to wipe state and run this code as the first command in one step. If the task exceeds timeout_s it is NOT killed: exec returns a task_id, then poll with pyrepl_read or stop with pyrepl_interrupt.",
        args: {
          code: tool.schema.string().describe("Python source to execute."),
          reset: tool.schema
            .boolean()
            .optional()
            .describe("If true, clear the namespace first and run code as exec #1. No fresh-session note is emitted since you asked for the reset."),
          timeout_s: tool.schema
            .number()
            .optional()
            .describe("Seconds to wait synchronously before returning a running task_id (default 30). The task keeps running after timeout; it is NOT killed."),
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
              const rr = await rpc(session, { op: "reset" }, 10000)
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
            // drops its registry on reset), so t_N always means exec #N.
            session.taskSeq = 0
          }
          session.taskSeq += 1
          const taskId = `t_${session.taskSeq}`
          const outcome = await rpcAbortable(
            session,
            { op: "execute", task_id: taskId, code: args.code, wait_ms: waitMs },
            waitMs + WAIT_GRACE_MS,
            context.abort,
          )
          if (outcome.aborted) {
            return `wait aborted by caller; task ${taskId} is still running. Use pyrepl_read to poll it or pyrepl_interrupt to stop it.`
          }
          const res = outcome.value
          if (args.reset) session.execCount = res?.n ?? 1
          return formatExecResult(res, session, freshNote)
        },
      }),

      pyrepl_read: tool({
        description:
          "Read buffered output of a REPL task. Use for tasks that timed out (status running) or outputs that were truncated. Supports line ranges, tail mode, stream selection and regex grep.",
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
            15000,
          )
          if (res?.status === "not_found") return `unknown task ${args.task_id}`
          if (res?.status === "error") return `read error: ${res.message ?? "unknown"}`
          const out: string[] = [`task ${res.task_id}: ${res.status} (exec #${res.n})`]
          if (res.result_full !== undefined && res.result_full !== null) {
            out.push(`Out[${res.n}] full (${res.result_chars} chars):`)
            out.push(res.result_full)
          } else {
            if (res.result_preview !== undefined) {
              out.push(`Out[${res.n}]: ${res.result_preview}`)
              if (res.result_truncated) {
                out.push(`[result ${res.result_chars} chars total, re-read with target=result for full]`)
              }
            }
          }
          if (res.error) {
            out.push(`${res.error.type}: ${res.error.message}`)
            if (res.error.traceback) out.push(res.error.traceback.trim())
          }
          const body = formatLines(res.lines ?? [], "output")
          if (body) {
            const t = truncatePreview(body)
            out.push(t.text)
            if (t.cut) out.push(`... [preview truncated, re-read with offset/limit]`)
          } else if (res.status === "running") {
            out.push("(no output yet)")
          }
          if (res.truncated_lines) out.push(`[note: ${res.truncated_lines} oldest lines dropped by ring buffer]`)
          if (res.orphan_new) {
            out.push(
              `[note: ${res.orphan_new} lines of background-thread output arrived during this task; re-read with target=orphan]`,
            )
          }
          if (res.orphan_truncated_lines) {
            out.push(`[note: ${res.orphan_truncated_lines} oldest orphan lines dropped by ring buffer]`)
          }
          return out.join("\n")
        },
      }),

      pyrepl_status: tool({
        description:
          "Show REPL session state without executing code: interpreter, exec count, running task and recent tasks. Use to re-orient after compaction or when unsure what is running.",
        args: {
          task_id: tool.schema
            .string()
            .optional()
            .describe("Check one task only instead of the whole session."),
        },
        async execute(args, context: ToolContext) {
          context.metadata({ title: "pyrepl status" })
          const session = sessions.get(context.sessionID)
          if (!session || session.dead) {
            return `no REPL session active. pyrepl_exec will auto-initialize one; sessions do not survive opencode restarts.`
          }
          let tasks: Array<{ task_id: string; n: number; task_status: string }> = []
          try {
            const res = await rpc(session, { op: "list" }, 10000)
            tasks = res?.tasks ?? []
          } catch {
            return `REPL on ${session.bin} (${session.version}) is not responding. Re-run pyrepl_init to respawn.`
          }
          if (args.task_id) {
            const found = tasks.find((t) => t.task_id === args.task_id)
            if (!found) return `unknown task ${args.task_id}`
            return `task ${found.task_id}: exec #${found.n}, ${found.task_status}`
          }
          const out = [
            `REPL on ${session.bin} (${session.version}), exec count ${session.execCount}`,
          ]
          if (tasks.length === 0) {
            out.push("no tasks yet")
          } else {
            for (const t of tasks) out.push(`- ${t.task_id}: exec #${t.n}, ${t.task_status}`)
          }
          return out.join("\n")
        },
      }),

      pyrepl_interrupt: tool({
        description:
          "Interrupt a running REPL task (SIGINT equivalent). Returns partial output. The session survives; only that task stops. If a blocking native call ignores the interrupt, re-init via pyrepl_init with the same bin_path to respawn.",
        args: {
          task_id: tool.schema.string().describe("Running task id from pyrepl_exec."),
        },
        async execute(args, context: ToolContext) {
          context.metadata({ title: `pyrepl interrupt ${args.task_id}` })
          const session = sessions.get(context.sessionID)
          if (!session || session.dead) return `no REPL session active (task ${args.task_id} unknown)`
          const res = await rpc(session, { op: "interrupt", task_id: args.task_id }, 15000)
          if (res?.status === "not_found") return `unknown task ${args.task_id}`
          if (res?.status === "error") return `interrupt error: ${res.message ?? "unknown"}`
          const out: string[] = [`task ${res.task_id}: ${res.status}`]
          if (res.message) out.push(res.message)
          const body = formatLines(res.lines ?? [], "partial output")
          if (body) {
            const t = truncatePreview(body)
            out.push(t.text)
            if (t.cut) out.push(`... [preview truncated, use pyrepl_read with task_id=${res.task_id}]`)
          }
          if (res.error) {
            out.push(`${res.error.type}: ${res.error.message}`)
          }
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
