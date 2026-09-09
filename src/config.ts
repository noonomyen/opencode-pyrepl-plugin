import { readFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Effective plugin configuration. Source of truth is pyrepl.jsonc files
// (global base, project override); missing files fall back to defaults.
// User-facing PYREPL_* environment variables are NOT read anymore: the TS
// side ignores them (warns once per fresh session) and injects the resolved
// values into the Python subprocess as private transport instead.

export type ConfigRoots = {
  worktree?: string | null
  directory?: string | null
}

export type ResolvedConfig = {
  python: string | null
  timeout_s: number
  wait_grace_ms: number
  rpc_timeout_ms: number
  preview_lines: number
  preview_head: number
  preview_tail: number
  notify_agent: boolean
  notify_poll_ms: number
  on_timeout: "interrupt" | "detach"
  max_lines: number
  max_bytes: number
  max_line_chars: number
  max_grep_chars: number
  result_max_chars: number
  result_max_store: number
  recent_tasks: number
  interrupt_wait_s: number
  max_mem_mb: number
  max_cpu_s: number
  max_nproc: number
  mem_warn_pct: number
}

export const DEFAULT_CONFIG: ResolvedConfig = {
  python: null,
  timeout_s: 60,
  wait_grace_ms: 15000,
  rpc_timeout_ms: 15000,
  preview_lines: 100,
  preview_head: 1000,
  preview_tail: 2500,
  notify_agent: true,
  notify_poll_ms: 5000,
  on_timeout: "interrupt",
  max_lines: 5000,
  max_bytes: 1000000,
  max_line_chars: 10000,
  max_grep_chars: 500,
  result_max_chars: 4000,
  result_max_store: 1000000,
  recent_tasks: 20,
  interrupt_wait_s: 5,
  max_mem_mb: 0,
  max_cpu_s: 0,
  max_nproc: 0,
  mem_warn_pct: 80,
}

type FieldSpec =
  | { kind: "int"; min: number }
  | { kind: "bool" }
  | { kind: "strOrNull" }
  | { kind: "enum"; values: readonly string[] }

const FIELDS: Record<keyof ResolvedConfig, FieldSpec> = {
  python: { kind: "strOrNull" },
  timeout_s: { kind: "int", min: 1 },
  wait_grace_ms: { kind: "int", min: 1 },
  rpc_timeout_ms: { kind: "int", min: 1 },
  preview_lines: { kind: "int", min: 1 },
  preview_head: { kind: "int", min: 1 },
  preview_tail: { kind: "int", min: 1 },
  notify_agent: { kind: "bool" },
  notify_poll_ms: { kind: "int", min: 1 },
  on_timeout: { kind: "enum", values: ["interrupt", "detach"] },
  max_lines: { kind: "int", min: 1 },
  max_bytes: { kind: "int", min: 1 },
  max_line_chars: { kind: "int", min: 1 },
  max_grep_chars: { kind: "int", min: 1 },
  result_max_chars: { kind: "int", min: 1 },
  result_max_store: { kind: "int", min: 1 },
  recent_tasks: { kind: "int", min: 1 },
  interrupt_wait_s: { kind: "int", min: 1 },
  max_mem_mb: { kind: "int", min: 0 },
  max_cpu_s: { kind: "int", min: 0 },
  max_nproc: { kind: "int", min: 0 },
  mem_warn_pct: { kind: "int", min: 0 },
}

// Strip // and /* */ comments plus trailing commas. String-aware so comment
// markers inside quotes survive. Minimal on purpose: zero dependencies.
export function stripJsonc(text: string): string {
  let out = ""
  let i = 0
  const n = text.length
  let inStr = false
  let quote = ""
  while (i < n) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === "\\" && i + 1 < n) {
        out += text[i + 1]
        i += 2
        continue
      }
      if (c === quote) inStr = false
      i++
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      i++
      continue
    }
    if (c === "/" && i + 1 < n && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++
      continue
    }
    if (c === "/" && i + 1 < n && text[i + 1] === "*") {
      i += 2
      while (i < n && !(text[i] === "*" && i + 1 < n && text[i + 1] === "/")) i++
      i += 2
      continue
    }
    out += c
    i++
  }
  return out.replace(/,\s*([}\]])/g, "$1")
}

function coerceInt(raw: unknown, fallback: number, min: number): { value: number; bad: boolean } {
  const v = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : (raw as number)
  if (typeof v !== "number" || !Number.isFinite(v) || v < min) return { value: fallback, bad: true }
  return { value: Math.floor(v), bad: false }
}

function coerceBool(raw: unknown, fallback: boolean): { value: boolean; bad: boolean } {
  if (typeof raw === "boolean") return { value: raw, bad: false }
  if (typeof raw === "number" && (raw === 0 || raw === 1)) return { value: raw === 1, bad: false }
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase()
    if (s === "true" || s === "1") return { value: true, bad: false }
    if (s === "false" || s === "0") return { value: false, bad: false }
  }
  return { value: fallback, bad: true }
}

function applyFile(
  base: ResolvedConfig,
  data: Record<string, unknown>,
  warnings: string[],
  source: string,
): ResolvedConfig {
  const next = { ...base }
  for (const [key, raw] of Object.entries(data)) {
    if (key === "$schema") continue
    // Own-property check: JSON can carry "__proto__" as an OWN key while
    // plain lookup would hit Object.prototype and misroute the value.
    const spec = Object.hasOwn(FIELDS, key)
      ? (FIELDS as Record<string, FieldSpec>)[key]
      : undefined
    if (!spec) {
      warnings.push(`unknown config key ${JSON.stringify(key)} in ${source}, ignored`)
      continue
    }
    if (spec.kind === "strOrNull") {
      if (raw === null || raw === undefined) {
        ;(next as Record<string, unknown>)[key] = null
      } else if (typeof raw === "string") {
        ;(next as Record<string, unknown>)[key] = raw.trim() === "" ? null : raw.trim()
      } else {
        warnings.push(`bad value for ${key} in ${source}, using default`)
      }
      continue
    }
    // Fall back to the already-merged lower layer (base), NOT defaults: a
    // typo in project config must not wipe a good global value.
    const fallback = (base as unknown as Record<string, unknown>)[key]
    if (spec.kind === "int") {
      const r = coerceInt(raw, fallback as number, spec.min)
      ;(next as Record<string, unknown>)[key] = r.value
      if (r.bad) warnings.push(`bad value for ${key} in ${source}, keeping ${fallback}`)
    } else if (spec.kind === "enum") {
      if (typeof raw === "string" && (spec.values as readonly string[]).includes(raw)) {
        ;(next as Record<string, unknown>)[key] = raw
      } else {
        warnings.push(`bad value for ${key} in ${source}, keeping ${fallback}`)
      }
    } else {
      const r = coerceBool(raw, fallback as boolean)
      ;(next as Record<string, unknown>)[key] = r.value
      if (r.bad) warnings.push(`bad value for ${key} in ${source}, keeping ${fallback}`)
    }
  }
  return next
}

export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME?.trim()
  // A relative XDG_CONFIG_HOME must resolve against $HOME, never cwd, or
  // installs land wherever opencode happened to start.
  if (xdg) return path.isAbsolute(xdg) ? xdg : path.join(homedir(), xdg)
  return path.join(homedir(), ".config")
}

export function configFilePaths(roots?: ConfigRoots): { global: string | null; projects: string[] } {
  const customDir = process.env.OPENCODE_CONFIG_DIR?.trim()
  const global =
    customDir != null && customDir !== ""
      ? path.join(customDir, "pyrepl.jsonc")
      : path.join(globalConfigDir(), "opencode", "pyrepl.jsonc")
  const seen = new Set<string>()
  const projects: string[] = []
  for (const root of [roots?.worktree, roots?.directory]) {
    if (!root) continue
    const p = path.join(root, ".opencode", "pyrepl.jsonc")
    if (!seen.has(p)) {
      seen.add(p)
      projects.push(p)
    }
  }
  return { global, projects }
}

type CachedFile = { mtimeMs: number; size: number; data: Record<string, unknown>; bad: string | null }
const fileCache = new Map<string, CachedFile>()

async function readOne(
  file: string,
): Promise<{ data: Record<string, unknown>; bad: string | null } | null> {
  let mtimeMs = 0
  let size = -1
  try {
    const st = await stat(file)
    // mtime alone can miss same-millisecond rewrites; size disambiguates.
    mtimeMs = st.mtimeMs
    size = st.size
  } catch {
    // Deleted since last read: purge so a recreated file is never shadowed.
    fileCache.delete(file)
    return null
  }
  const hit = fileCache.get(file)
  if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit
  let text: string
  try {
    text = await readFile(file, "utf-8")
  } catch {
    fileCache.delete(file)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonc(text))
  } catch (e) {
    const bad = `ignoring ${file}: invalid JSONC (${e instanceof Error ? e.message : String(e)})`
    const entry: CachedFile = { mtimeMs, size, data: {}, bad }
    fileCache.set(file, entry)
    return entry
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const bad = `ignoring ${file}: top level must be an object`
    const entry: CachedFile = { mtimeMs, size, data: {}, bad }
    fileCache.set(file, entry)
    return entry
  }
  const entry: CachedFile = { mtimeMs, size, data: parsed as Record<string, unknown>, bad: null }
  fileCache.set(file, entry)
  return entry
}

export type LoadedConfig = {
  config: ResolvedConfig
  warnings: string[]
  // Short labels for the fresh note: "global", "project", or both.
  sources: string[]
}

export async function loadMergedConfig(roots?: ConfigRoots): Promise<LoadedConfig> {
  const warnings: string[] = []
  const sources: string[] = []
  let merged: ResolvedConfig = { ...DEFAULT_CONFIG }
  const { global, projects } = configFilePaths(roots)
  if (global) {
    const r = await readOne(global)
    if (r) {
      if (r.bad) warnings.push(r.bad)
      else {
        merged = applyFile(merged, r.data, warnings, "global pyrepl.jsonc")
        sources.push("global")
      }
    }
  }
  for (const p of projects) {
    const r = await readOne(p)
    if (r) {
      if (r.bad) warnings.push(r.bad)
      else {
        merged = applyFile(merged, r.data, warnings, "project pyrepl.jsonc")
        if (!sources.includes("project")) sources.push("project")
      }
    }
  }
  return { config: merged, warnings, sources }
}

export async function getConfig(roots?: ConfigRoots): Promise<ResolvedConfig> {
  return (await loadMergedConfig(roots)).config
}

// Transport to the Python subprocess: the server still parses its own
// environment, but the TS side sets these programmatically from the merged
// file. User-exported PYREPL_* vars are scrubbed first (file-only).
const PY_ENV_MAP: Array<[keyof ResolvedConfig, string]> = [
  ["max_lines", "PYREPL_MAX_LINES"],
  ["max_bytes", "PYREPL_MAX_BYTES"],
  ["max_line_chars", "PYREPL_MAX_LINE_CHARS"],
  ["max_grep_chars", "PYREPL_MAX_GREP_CHARS"],
  ["result_max_chars", "PYREPL_RESULT_MAX_CHARS"],
  ["result_max_store", "PYREPL_RESULT_MAX_STORE"],
  ["recent_tasks", "PYREPL_RECENT_TASKS"],
  ["interrupt_wait_s", "PYREPL_INTERRUPT_WAIT_S"],
  ["max_mem_mb", "PYREPL_MAX_MEM_MB"],
  ["max_cpu_s", "PYREPL_MAX_CPU_S"],
  ["max_nproc", "PYREPL_MAX_NPROC"],
  ["mem_warn_pct", "PYREPL_MEM_WARN_PCT"],
]

export function toPythonEnv(cfg: ResolvedConfig): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, name] of PY_ENV_MAP) {
    env[name] = String(cfg[key])
  }
  return env
}

// User-facing env vars are file-only now; anything starting with PYREPL_
// in the operator environment is ignored. Env names are case-sensitive on
// POSIX but not on Windows; match the platform so a lowercase smuggle
// cannot survive where the OS folds case.
export function isManagedEnvKey(k: string): boolean {
  return process.platform === "win32" ? k.toUpperCase().startsWith("PYREPL_") : k.startsWith("PYREPL_")
}

export function collectIgnoredEnv(): string[] {
  return Object.keys(process.env).filter(isManagedEnvKey)
}

// Locate the engine next to this module (src layout: pyrepl_server.py
// shim) or next to the bundle (dist layout: pyrepl.pyz). Returns null
// when nothing exists so the caller can fail fast instead of spawning
// python on a missing file and timing out on the ping.
export function resolveServerFile(metaUrl: string): string | null {
  let here: string
  try {
    here = path.dirname(fileURLToPath(metaUrl))
  } catch {
    return null
  }
  for (const c of [path.join(here, "pyrepl.pyz"), path.join(here, "pyrepl_server.py")]) {
    if (existsSync(c)) return c
  }
  return null
}

export const CONFIG_TEMPLATE = `{
  // Optional: explicit interpreter. null = auto (.venv in worktree/directory, then python3).
  "python": null,

  // TS-side knobs.
  "timeout_s": 60,          // per-exec synchronous wait
  "on_timeout": "interrupt",// "interrupt" (stop it, return partial output) or "detach" (keep running, return task_id)
  "wait_grace_ms": 15000,   // extra RPC grace on top of timeout_s
  "rpc_timeout_ms": 15000,  // read/status/interrupt round-trip budget
  "preview_lines": 100,     // line cap for medium outputs (char budget wins for big ones)
  "preview_head": 1000,
  "preview_tail": 2500,     // tail-heavy so END markers survive
  "notify_agent": true,     // wake the agent in-session when a background task finishes
  "notify_poll_ms": 5000,

  // Engine knobs (applied at server boot).
  "max_lines": 5000,
  "max_bytes": 1000000,
  "max_line_chars": 10000,
  "max_grep_chars": 500,
  "result_max_chars": 4000,
  "result_max_store": 1000000,
  "recent_tasks": 20,
  "interrupt_wait_s": 5,
  "max_mem_mb": 0,           // 0 = off; overuse raises MemoryError in the task
  "max_cpu_s": 0,           // 0 = off; overuse kills the server (respawned fresh)
  "max_nproc": 0,           // 0 = off; UID-wide anti fork-bomb cap
  "mem_warn_pct": 80        // warn-only past this % of max_mem_mb, 0 = off
}
`
