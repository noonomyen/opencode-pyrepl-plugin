import type { ToolContext } from "@opencode-ai/plugin"
import { access, realpath } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import {
  collectIgnoredEnv,
  isManagedEnvKey,
  loadMergedConfig,
  resolveServerFile,
  toPythonEnv,
  type ConfigRoots,
  type LoadedConfig,
  type ResolvedConfig,
} from "./config.ts"
import { formatLimitNote } from "./format.ts"
import { killSession, rpc, spawnSession } from "./rpc.ts"
import type { Session, TaskListResponse } from "./types.ts"

export const sessions = new Map<string, Session>()
// Background tasks whose wake-up prompt failed to admit (e.g. session
// gone): retried on the next session.idle event. Values carry the agent
// so the retry wakes up as the same agent.
export const pendingNotify = new Map<string, Map<string, string | undefined>>()

export function isTerminalTaskStatus(status: string | undefined): boolean {
  return status !== undefined && status !== "running"
}

export async function existsExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function probePython(bin: string): Promise<{ ok: boolean; version: string }> {
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

export async function resolveBin(
  explicit: string | undefined,
  ctx: ToolContext | ConfigRoots,
  config: ResolvedConfig,
): Promise<string> {
  if (explicit?.trim()) return explicit.trim()
  if (config.python) return config.python
  for (const root of [ctx.worktree, ctx.directory]) {
    if (!root) continue
    const unix = path.join(root, ".venv", "bin", "python")
    if (await existsExecutable(unix)) return unix
    const win = path.join(root, ".venv", "Scripts", "python.exe")
    if (await existsExecutable(win)) return win
  }
  return "python3"
}

// A venv python is a symlink to its base interpreter, so same-target must
// not imply same-environment (different sys.prefix/site-packages): treat
// venv binaries conservatively, by literal path only.
async function isVenvBin(bin: string): Promise<boolean> {
  const dir = path.dirname(bin)
  for (const c of [path.join(dir, "..", "pyvenv.cfg"), path.join(dir, "pyvenv.cfg")]) {
    try {
      await access(c)
      return true
    } catch {
    }
  }
  return false
}

async function canonicalBin(bin: string): Promise<{ real: string; venv: boolean } | null> {
  let p = bin
  if (!p.includes(path.sep)) {
    // Bare name (e.g. "python3"): resolve through PATH first.
    let found: string | null = null
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!dir) continue
      const c = path.join(dir, bin)
      if (await existsExecutable(c)) {
        found = c
        break
      }
      if (process.platform === "win32" && await existsExecutable(c + ".exe")) {
        found = c + ".exe"
        break
      }
    }
    if (!found) return null
    p = found
  }
  try {
    return { real: await realpath(p), venv: await isVenvBin(p) }
  } catch {
    return null
  }
}

// Same interpreter, tolerant of spelling: symlinks (/usr/bin/python3 vs
// python3.14), /bin vs /usr/bin merges, bare names via PATH. Falls back
// to strict equality when either side is unresolvable, and never merges
// a venv python with its base interpreter. Exported for tests.
export async function sameInterpreter(a: string, b: string): Promise<boolean> {
  if (a === b) return true
  const [ca, cb] = await Promise.all([canonicalBin(a), canonicalBin(b)])
  if (!ca || !cb || ca.real !== cb.real) return false
  return !ca.venv && !cb.venv
}

// Build the child environment: inherit everything (PATH/HOME matter) but
// scrub operator PYREPL_* vars (file-only), then inject resolved transport.
// Exported for tests pinning the isolation boundary.
export function buildServerEnv(config: ResolvedConfig): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const k of Object.keys(env)) {
    if (isManagedEnvKey(k)) delete env[k]
  }
  Object.assign(env, toPythonEnv(config))
  return env
}

export function contextRoots(ctx: ToolContext | ConfigRoots): ConfigRoots {
  return { worktree: ctx.worktree ?? null, directory: ctx.directory ?? null }
}

export type RunningTaskCheck = { responsive: boolean; runningId: string | null }

// Single place asking the server what is running: init needs both the
// responsiveness verdict (fail-closed on unknown state) and the id,
// while interrupt/read only need the id for their blank-arg hint.
export async function checkRunningTask(session: Session, timeoutMs: number): Promise<RunningTaskCheck> {
  try {
    const list = await rpc<TaskListResponse>(session, { op: "list" }, timeoutMs)
    return {
      responsive: true,
      runningId: list?.tasks?.find((t) => t.task_status === "running")?.task_id ?? null,
    }
  } catch {
    return { responsive: false, runningId: null }
  }
}

export async function ensureSession(
  key: string,
  bin: string,
  ctx: ToolContext | ConfigRoots,
  preloaded?: LoadedConfig,
): Promise<{ session: Session; note: string | null }> {
  const loaded = preloaded ?? (await loadMergedConfig(ctx))
  const existing = sessions.get(key)
  if (existing && !existing.dead && (await sameInterpreter(existing.bin, bin))) {
    // Live session sticks (never kill a running task for config): refresh
    // TS-side knobs in place, Python-side knobs stay frozen at spawn.
    existing.config = loaded.config
    existing.roots = contextRoots(ctx)
    return { session: existing, note: null }
  }
  if (existing) killSession(existing)
  const probe = await probePython(bin)
  if (!probe.ok) {
    throw new Error(
      `python interpreter not usable: ${bin}. Pass a valid bin_path to pyrepl_init (e.g. /usr/bin/python3 or <venv>/bin/python), or set "python" in pyrepl.jsonc.`,
    )
  }
  const roots = contextRoots(ctx)
  const serverFile = resolveServerFile(import.meta.url)
  if (serverFile === null) {
    throw new Error(
      `pyrepl engine not found (looked for pyrepl.pyz then pyrepl_server.py next to the plugin file)`,
    )
  }
  const session = await spawnSession(
    bin,
    probe.version,
    loaded.config,
    roots,
    serverFile,
    buildServerEnv(loaded.config),
  )
  sessions.set(key, session)
  let note = `fresh REPL session on ${bin} (${probe.version}); state is new and is lost when opencode closes`
  const lim = formatLimitNote(session.limits)
  if (lim) note += `; ${lim}`
  if (loaded.sources.length > 0) note += `; config: ${loaded.sources.join("+")}`
  const warnings = [...loaded.warnings]
  const ignored = collectIgnoredEnv()
  if (ignored.length > 0) {
    warnings.push(`ignored env (file-only config): ${ignored.join(",")} - use pyrepl.jsonc`)
  }
  if (warnings.length > 0) note += `; [config warnings: ${warnings.join("; ")}]`
  return { session, note }
}

export async function respawnIfDead(
  key: string,
  session: Session,
  context: ToolContext,
): Promise<{ session: Session; note: string }> {
  sessions.delete(key)
  const loaded = await loadMergedConfig(context)
  const candidates = [session.bin, await resolveBin(undefined, context, loaded.config)]
  for (const bin of candidates) {
    try {
      const revived = await ensureSession(key, bin, context, loaded)
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

export function consumeFreshNote(
  session: Session,
  note: string | null,
  reset: boolean | undefined,
): string | null {
  const wasFresh = session.freshPending
  session.freshPending = false
  if (!wasFresh || reset) return null
  return note ?? `fresh REPL session on ${session.bin}; state is new and is lost when opencode closes`
}
