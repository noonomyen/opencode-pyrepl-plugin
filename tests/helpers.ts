/** Shared helpers for the public test suites (bun:test, ubuntu only).
 *
 * - ProcClient: drives src/pyrepl_server.py over NDJSON stdio, mirroring
 *   the .local regression client (single stdout pump, id-routed replies).
 * - fakeCtx / loadPlugin: drive the TS tool layer without a live opencode.
 * - Paths are relative to this file; no absolute paths, no shared /tmp.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"

export const SERVER_FILE = fileURLToPath(new URL("../src/pyrepl_server.py", import.meta.url))

type Pending = {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class ProcClient {
  proc: ChildProcess
  seq = 0
  pending = new Map<number, Pending>()
  buf = ""
  decoder = new TextDecoder()
  badLines: string[] = []
  unknownIds: number[] = []
  exited: Promise<number | null>
  private exitResolve!: (v: number | null) => void

  constructor(env?: Record<string, string>, argv?: string[]) {
    this.proc = spawn("python3", argv ?? [SERVER_FILE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(env ?? {}) },
    })
    this.exited = new Promise<number | null>((resolve) => {
      this.exitResolve = resolve
    })
    this.proc.on("exit", (code) => this.exitResolve(code ?? -1))
    this.proc.on("error", (err) => this.failAll(err instanceof Error ? err : new Error(String(err))))
    this.proc.stdout!.on("data", (chunk: unknown) => this.onData(chunk))
    this.proc.stdout!.on("close", () => this.failAll(new Error("server stdout closed")))
  }

  onData(chunk: unknown) {
    this.buf += this.decoder.decode(chunk as ArrayBufferView, { stream: true })
    let idx: number
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx)
      this.buf = this.buf.slice(idx + 1)
      if (!line.trim()) continue
      let msg: any
      try {
        msg = JSON.parse(line)
      } catch {
        this.badLines.push(line)
        continue
      }
      const pend = this.pending.get(msg?.id)
      if (pend) {
        this.pending.delete(msg.id)
        clearTimeout(pend.timer)
        pend.resolve(msg)
      } else if (typeof msg?.id === "number") {
        this.unknownIds.push(msg.id)
      }
    }
  }

  failAll(err: Error) {
    for (const [, pend] of this.pending) {
      clearTimeout(pend.timer)
      pend.reject(err)
    }
    this.pending.clear()
  }

  call(obj: Record<string, any>, timeoutMs = 30000): Promise<any> {
    this.seq += 1
    const id = this.seq
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`no response for ${JSON.stringify(obj)}`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.proc.stdin!.write(JSON.stringify({ ...obj, id }) + "\n")
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    })
  }

  async close() {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return
    try {
      await this.call({ op: "shutdown" }, 5000)
    } catch {
    }
    try {
      const code = await new Promise<number | null>((resolve) => {
        const t = setTimeout(() => resolve(null), 5000)
        this.proc.on("exit", (c) => {
          clearTimeout(t)
          resolve(c)
        })
      })
      if (code === null) this.proc.kill("SIGKILL")
    } catch {
      try {
        this.proc.kill("SIGKILL")
      } catch {
      }
    }
  }
}

export function testDir(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

export function fakeCtx(sessionID: string, dir?: string): any {
  const d = dir ?? testDir("pyrepl-test-")
  return {
    sessionID,
    messageID: "m1",
    agent: "build",
    directory: d,
    worktree: d,
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

export async function loadPlugin(input?: any): Promise<any> {
  const { PyReplPlugin } = await import("../src/pyrepl.ts")
  return await PyReplPlugin((input ?? {}) as any)
}

export function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms))
}

/** Poll list until a task reaches a status (or timeout). Removes the
 * spawn-then-fixed-sleep race on slow/loaded machines. */
export async function waitForTask(
  c: ProcClient,
  taskId: string,
  want: string[] = ["running"],
  timeoutMs = 10000,
): Promise<any> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const r = await c.call({ op: "list" }, 10000)
    const found = (r.tasks ?? []).find((t: any) => t.task_id === taskId)
    if (found && want.includes(found.task_status)) return found
    if (Date.now() >= deadline) throw new Error(`task ${taskId} never became ${want}`)
    await sleep(200)
  }
}
