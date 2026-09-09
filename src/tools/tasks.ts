import type { ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadMergedConfig } from "../config.ts"
import { formatTaskLine } from "../format.ts"
import { rpc } from "../rpc.ts"
import { sessions } from "../session.ts"
import type { TaskListResponse, VarsResponse } from "../types.ts"
import { GUIDE, type ToolDeps } from "./common.ts"

export function createTasksTool(_deps: ToolDeps) {
  return tool({
    description:
      "List tasks: running plus recent history (limit/filter), or one task by id. Appends the compact namespace listing (name: type per line) so stale variables are visible next to the tasks that created them. Output lines of finished tasks are already dropped; use pyrepl_read target=result for values." +
      GUIDE,
    args: {
      task_id: tool.schema
        .string()
        .optional()
        .describe("Check one task only instead of listing."),
      limit: tool.schema
        .number()
        .optional()
        .describe("Show this many recent tasks (default 10)."),
      filter: tool.schema
        .enum(["all", "running", "failed"])
        .optional()
        .describe("History filter: all, running only, or failed (error+interrupted). Default all."),
    },
    async execute(args, context: ToolContext) {
      context.metadata({ title: "pyrepl tasks" })
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
      const out: string[] = []
      if (args.task_id) {
        const found = tasks.find((t) => t.task_id === args.task_id)
        if (!found) return `unknown task ${args.task_id}`
        out.push(formatTaskLine(found, false))
      } else {
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
      }
      // Appended vars: compact name/type listing so namespace growth and
      // stale names are visible right where tasks are reviewed.
      try {
        const vars = await rpc<VarsResponse>(
          session,
          { op: "vars", pattern: null, limit: 100, sort: "name", name: null },
          session.config.rpc_timeout_ms,
        )
        if (vars?.status === "error") {
          out.push(`vars error: ${vars.message ?? "unknown"}`)
        } else {
          const entries = vars?.vars ?? []
          out.push(`vars (${vars?.count ?? entries.length}):`)
          for (const v of entries) out.push(`  ${v.name}: ${v.type}`)
          if (vars?.truncated) out.push(`  ... and more (pyrepl_vars for the full list)`)
        }
      } catch {
        out.push(`vars: unavailable (session not responding)`)
      }
      return out.join("\n")
    },
  })
}
