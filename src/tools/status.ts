import type { ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadMergedConfig } from "../config.ts"
import { formatLimitsLine, formatProcLine, formatTaskLine } from "../format.ts"
import { rpc } from "../rpc.ts"
import { sessions } from "../session.ts"
import type { TaskListResponse } from "../types.ts"
import { GUIDE, type ToolDeps } from "./common.ts"

export function createStatusTool(_deps: ToolDeps) {
  return tool({
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
      session.config = (await loadMergedConfig(context)).config
      let list: TaskListResponse
      try {
        list = await rpc<TaskListResponse>(session, { op: "list" }, session.config.rpc_timeout_ms)
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
  })
}
