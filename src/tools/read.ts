import type { ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadMergedConfig } from "../config.ts"
import {
  formatDropNotes,
  formatErrorLines,
  formatOrphanHint,
  formatOutputPreview,
  formatResources,
  formatResultValue,
  formatWarn,
} from "../format.ts"
import { rpc } from "../rpc.ts"
import { isTerminalTaskStatus, sessions } from "../session.ts"
import { GUIDE, type ToolDeps } from "./common.ts"

export function createReadTool(_deps: ToolDeps) {
  return tool({
    description:
      "Read a RUNNING task's output (line ranges, tail mode, stream selection, regex grep) or a finished task's value (target=result) and orphan stream. Finished tasks keep no output lines: only live output pages." +
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
      // Live-refresh TS-side knobs (preview/rpc budgets) like exec/init do;
      // engine-side knobs stay frozen at spawn by design.
      session.config = (await loadMergedConfig(context)).config
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
        session.config.rpc_timeout_ms,
      )
      if (res?.status === "not_found") return `unknown task ${args.task_id}`
      if (res?.status === "error") return `read error: ${res.message ?? "unknown"}`
      if (isTerminalTaskStatus(res?.status) && res?.task_id) session.consumed.add(res.task_id)
      const out: string[] = [`task ${res.task_id}: ${res.status}`]
      out.push(...formatResultValue(res, "re-read with target=result for full"))
      out.push(...formatErrorLines(res, true))
      const preview = formatOutputPreview(
        res,
        "output",
        `... [preview truncated, re-read with offset/limit]`,
        false,
        session.config,
      )
      if (preview.length > 0) out.push(...preview)
      else if (res.status === "running") out.push("(no output yet)")
      if (res.note) out.push(`[note: ${res.note}]`)
      out.push(...formatDropNotes(res, true))
      out.push(...formatOrphanHint(res, "re-read with"))
      out.push(...formatWarn(res))
      out.push(formatResources(res))
      return out.join("\n")
    },
  })
}
