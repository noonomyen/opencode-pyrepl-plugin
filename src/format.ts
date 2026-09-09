import { DEFAULT_CONFIG } from "./config.ts"
import type { ProcSnapshot, ServerLimits, TaskListEntry, TaskResponse } from "./types.ts"

export type PreviewCfg = {
  preview_lines: number
  preview_head: number
  preview_tail: number
}

// Millis with sub-ms precision (server sends floats); integers stay bare.
export function fmtMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "?"
  return `${Number.isInteger(ms) ? ms : ms.toFixed(1)}ms`
}

// Unsigned magnitude; callers add their own sign when needed.
export function fmtSize(bytes: number): string {
  const abs = Math.abs(bytes)
  if (abs >= 1024 ** 3) return `${(abs / 1024 ** 3).toFixed(1)}GB`
  if (abs >= 1024 ** 2) return `${(abs / 1024 ** 2).toFixed(1)}MB`
  if (abs >= 1024) return `${Math.round(abs / 1024)}KB`
  return `${abs}B`
}

// Single machine-readable resource line appended to every task output.
// Always present; fields omitted when the platform cannot measure them.
export function formatResources(res: TaskResponse): string {
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

export function formatWarn(res: TaskResponse): string[] {
  return res.mem_warn ? [`[warn: ${res.mem_warn}]`] : []
}

export function formatLines(
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

export function truncatePreview(
  text: string,
  cfg: PreviewCfg = DEFAULT_CONFIG,
): { text: string; cut: boolean } {
  // Char budget first: head+tail on the FULL text so the end (END-MARKERs,
  // final errors) always survives. Line cap only for medium outputs.
  if (text.length > cfg.preview_head + cfg.preview_tail) {
    const omitted = text.length - cfg.preview_head - cfg.preview_tail
    return {
      text:
        text.slice(0, cfg.preview_head) +
        `\n... [${omitted} chars omitted, END follows] ...\n` +
        text.slice(-cfg.preview_tail),
      cut: true,
    }
  }
  const lines = text.split("\n")
  const out = lines.slice(0, cfg.preview_lines).join("\n")
  return { text: out, cut: lines.length > cfg.preview_lines }
}

export function formatOutputPreview(
  res: TaskResponse,
  label: string,
  cutHint: string,
  extraCut = false,
  cfg: PreviewCfg = DEFAULT_CONFIG,
): string[] {
  const body = formatLines(res.lines ?? [], label)
  if (!body) return []
  const t = truncatePreview(body, cfg)
  const out = [t.text]
  if (t.cut || extraCut) out.push(cutHint)
  return out
}

export function formatResultValue(res: TaskResponse, fullRef: string): string[] {
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

export function formatErrorLines(res: TaskResponse, withTraceback: boolean): string[] {
  if (!res.error) return []
  const out = [`${res.error.type}: ${res.error.message}`]
  if (withTraceback && res.error.traceback) out.push(res.error.traceback.trim())
  return out
}

export function formatDropNotes(res: TaskResponse, includeOrphanDrops: boolean): string[] {
  const out: string[] = []
  if (res.truncated_lines) out.push(`[note: ${res.truncated_lines} oldest lines dropped by ring buffer]`)
  if (includeOrphanDrops && res.orphan_truncated_lines) {
    out.push(`[note: ${res.orphan_truncated_lines} oldest orphan lines dropped by ring buffer]`)
  }
  return out
}

export function formatOrphanHint(res: TaskResponse, verb: string): string[] {
  if (!res.orphan_new) return []
  return [
    `[note: ${res.orphan_new} lines of background-thread output arrived during this task; ${verb} with target=orphan]`,
  ]
}

export function formatExecResult(
  res: TaskResponse,
  session: { execCount: number; config: PreviewCfg },
  freshNote: string | null,
): string {
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
  // Generic errors carry their reason in message (not the error object).
  if (res.status === "error" && res.message) out.push(res.message)
  // Lines are gone at completion (dropped, not just unshown): only promise
  // target=result when the task actually produced a value.
  const cutHint =
    res.result_preview !== undefined
      ? `... [output truncated at completion; older lines were dropped, use pyrepl_read task_id=${res.task_id} target=result for the value]`
      : `... [output truncated at completion; older lines were dropped]`
  out.push(
    ...formatOutputPreview(
      res,
      `task ${res.task_id ?? "?"}`,
      cutHint,
      (res.line_count ?? 0) > session.config.preview_lines,
      session.config,
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

// Short wake-up: single task id plus cost facts, no output dump. The agent
// pulls the output itself with pyrepl_read.
export function formatCompletionNotice(taskId: string, res: TaskResponse): string {
  const out = [
    `background task done: task_id=${taskId}, status=${res.status}, elapsed=${res.elapsed_ms ?? "?"}ms, output=${res.output_lines ?? "?"} lines / ${res.output_bytes ?? "?"} bytes`,
  ]
  if (res.error) out.push(`${res.error.type}: ${res.error.message}`)
  out.push(`Use pyrepl_read task_id=${taskId} for the full output.`)
  return `<pyrepl>\n${out.join("\n")}\n<pyrepl>`
}

export function formatDeathNotice(taskId: string): string {
  return `<pyrepl>\ntask ${taskId} lost: REPL server died, state lost. Re-run pyrepl_exec to respawn fresh.\n<pyrepl>`
}

export function formatLostNotice(taskId: string): string {
  return `<pyrepl>\ntask ${taskId} lost: no longer on server (registry evicted or cleared). Output unavailable.\n<pyrepl>`
}

export function formatTaskLine(t: TaskListEntry, dash: boolean): string {
  const parts = [`${t.task_id}: ${t.task_status}`, `wall=${fmtMs(t.elapsed_ms)}`]
  if ((t.output_lines ?? 0) > 0 || t.task_status === "running") {
    parts.push(`out=${t.output_lines ?? 0}lines/${fmtSize(t.output_bytes ?? 0)}`)
  }
  if (t.error_type) parts.push(`err=${t.error_type}`)
  return `${dash ? "- " : "task "}${parts.join(" ")}`
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

export function formatLimitNote(limits: ServerLimits | null): string | null {
  if (!limits) return null
  const parts = [
    formatCap("mem_limit", "MB", limits.mem_limit_mb, limits.mem_enforced, limits.reason),
    formatCap("cpu_limit", "s", limits.cpu_limit_s, limits.cpu_enforced, limits.reason),
  ].filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join(" ") : null
}

export function formatLimitsLine(limits: ServerLimits | null | undefined): string[] {
  if (!limits) return []
  const mem = formatCap("mem", "MB", limits.mem_limit_mb, limits.mem_enforced, limits.reason) ?? "mem=unlimited"
  const cpu = formatCap("cpu", "s", limits.cpu_limit_s, limits.cpu_enforced, limits.reason) ?? "cpu=unlimited"
  const nproc =
    (limits.nproc_limit ?? 0) > 0
      ? ` ${formatCap("nproc", "", limits.nproc_limit, limits.nproc_enforced ?? false, limits.reason) ?? ""}`
      : ""
  return [`limits: ${mem} ${cpu}${nproc}`]
}

export function formatProcLine(proc: ProcSnapshot | null | undefined): string[] {
  if (!proc) return []
  const parts: string[] = []
  if (proc.cwd !== undefined) parts.push(`cwd=${proc.cwd}`)
  if (proc.uptime_ms !== undefined) parts.push(`uptime=${fmtMs(proc.uptime_ms)}`)
  if (proc.rss_bytes !== undefined) parts.push(`rss=${fmtSize(proc.rss_bytes)}`)
  if (proc.peak_rss_bytes !== undefined) parts.push(`peak=${fmtSize(proc.peak_rss_bytes)}`)
  if (proc.cpu_total_ms !== undefined) parts.push(`cpu_total=${fmtMs(proc.cpu_total_ms)}`)
  return parts.length > 0 ? [`proc: ${parts.join(" ")}`] : []
}
