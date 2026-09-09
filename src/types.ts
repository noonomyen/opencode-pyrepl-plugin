import type { ChildProcess } from "node:child_process"
import type { Writable } from "node:stream"
import type { ConfigRoots, ResolvedConfig } from "./config.ts"

export type RpcPending = {
  resolve: (value: TaskResponse) => void
  reject: (err: Error) => void
}

export type TaskLine = {
  stream: string
  line: string
}

export type TaskError = {
  type: string
  message: string
  traceback?: string
}

// One shape for every task-related RPC response (execute/read/interrupt).
// Optional fields because each op fills a different subset.
export type TaskResponse = {
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
  returned?: number
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

export type TaskListEntry = {
  task_id: string
  n: number
  task_status: string
  elapsed_ms?: number
  output_lines?: number
  output_bytes?: number
  error_type?: string
}

export type ProcSnapshot = {
  vars?: number
  cpu_total_ms?: number
  rss_bytes?: number
  peak_rss_bytes?: number
}

export type ServerLimits = {
  mem_limit_mb: number
  mem_enforced: boolean
  cpu_limit_s: number
  cpu_enforced: boolean
  nproc_limit: number
  nproc_enforced: boolean
  reason?: string | null
}

export type TaskListResponse = {
  status: string
  tasks?: TaskListEntry[]
  proc?: ProcSnapshot
  limits?: ServerLimits
}

export type PingResponse = {
  status: string
  version?: string
  python?: string
  limits?: ServerLimits
  proc?: ProcSnapshot
}

export type Session = {
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
  // Effective file config. TS-side knobs (timeout/preview/notify) refresh
  // on every tool call; Python-side knobs freeze at spawn (server boot).
  config: ResolvedConfig
  // Config discovery roots at spawn (worktree/directory), so event paths
  // without a ToolContext can resolve the same merged file config.
  roots: ConfigRoots
  // Bumped on every reset: waiters armed before the reset exit silently
  // instead of watching a recycled task id.
  resetSeq: number
  // Task ids whose final output already reached the agent inline (foreground
  // exec/read/interrupt): no wake-up prompt needed. Task ids already pushed
  // via session.prompt: notify-once, prevents idle->prompt->idle loops.
  consumed: Set<string>
  notified: Set<string>
}

// Minimal client surface used for agent wake-ups (full SDK client in prod).
export type NotifyClient = {
  session: {
    promptAsync: (opts: {
      path: { id: string }
      body: { parts: Array<{ type: "text"; text: string; synthetic?: boolean }>; agent?: string }
    }) => Promise<unknown>
  }
}
