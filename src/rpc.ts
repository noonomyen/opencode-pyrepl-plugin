import { spawn, type ChildProcess } from "node:child_process"
import type { Readable, Writable } from "node:stream"
import type { ConfigRoots, ResolvedConfig } from "./config.ts"
import type { PingResponse, Session, TaskResponse } from "./types.ts"

export function drainStderr(session: Session, stderr: Readable | null) {
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

export function handleLine(session: Session, line: string) {
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

export function pumpStdout(session: Session, stdout: Readable | null) {
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

export function spawnServerProcess(
  bin: string,
  serverFile: string,
  env: NodeJS.ProcessEnv,
): { proc: ChildProcess; exited: Promise<number> } {
  const proc = spawn(bin, [serverFile], { stdio: ["pipe", "pipe", "pipe"], env })
  const exited = new Promise<number>((resolve) => {
    proc.on("error", () => resolve(-1))
    proc.on("exit", (code) => resolve(code ?? -1))
  })
  return { proc, exited }
}

export async function spawnSession(
  bin: string,
  version: string,
  config: ResolvedConfig,
  roots: ConfigRoots,
  serverFile: string,
  env: NodeJS.ProcessEnv,
): Promise<Session> {
  const { proc, exited } = spawnServerProcess(bin, serverFile, env)
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
    config,
    roots,
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
  let pong: PingResponse
  try {
    pong = await rpc<PingResponse>(session, { op: "ping" }, config.rpc_timeout_ms)
  } catch (e) {
    // Ping reject (timeout/dead pipe) must also kill: otherwise the
    // spawned process is orphaned with no session owning it.
    proc.kill("SIGKILL")
    throw e instanceof Error ? e : new Error(String(e))
  }
  if (pong?.status !== "ok") {
    proc.kill("SIGKILL")
    throw new Error(`repl server failed to start (bin=${bin}): ${session.stderrTail}`)
  }
  session.limits = pong?.limits ?? null
  return session
}

// Write one line, awaiting the stream flush callback so delivery to the
// subprocess stdin pipe is guaranteed before returning.
export function writeLine(writer: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    writer.write(line, (err) => {
      if (err) reject(err instanceof Error ? err : new Error(String(err)))
      else resolve()
    })
  })
}

export function rpc<T = TaskResponse>(
  session: Session,
  body: Record<string, any>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<T> {
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
    // Serialize synchronously (its throw is the only sync failure here),
    // then fire-and-forget the pipe write: the .catch owns rejections,
    // so no outer try/catch can mislead about who handles what.
    let line: string
    try {
      line = JSON.stringify({ ...body, id }) + "\n"
    } catch (e) {
      if (settled) return
      settled = true
      cleanup()
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    void writeLine(session.writer, line).catch((e: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(e instanceof Error ? e : new Error(String(e)))
    })
  })
}

export async function rpcAbortable(
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

export function killSession(session: Session) {
  try {
    session.proc.kill("SIGKILL")
  } catch {
  }
}
