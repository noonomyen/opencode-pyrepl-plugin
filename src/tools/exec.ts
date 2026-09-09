import type { ToolContext } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadMergedConfig } from "../config.ts"
import { formatExecResult } from "../format.ts"
import { notifyWhenDone } from "../notify.ts"
import { killSession, rpc, rpcAbortable } from "../rpc.ts"
import {
  consumeFreshNote,
  ensureSession,
  pendingNotify,
  resolveBin,
  respawnIfDead,
  sessions,
} from "../session.ts"
import { GUIDE, type ToolDeps } from "./common.ts"

export function createExecTool(deps: ToolDeps) {
  return tool({
    description:
      "Execute Python code in the persistent REPL. Variables, imports and functions survive across calls. Auto-initializes if needed. Set reset=true to wipe state and run this code as the first command in one step. If the task exceeds timeout_s it is interrupted by default (on_timeout=interrupt, partial output returned); on_timeout=detach instead returns a task_id and the agent is automatically notified in its session on completion (disable via notify_agent in pyrepl.jsonc); polling with pyrepl_read stays optional." +
      GUIDE,
    args: {
      code: tool.schema.string().describe("Python source to execute."),
      reset: tool.schema
        .boolean()
        .optional()
        .describe("If true, clear the namespace first and run code as t_1. No fresh-session note is emitted since you asked for the reset."),
      timeout_s: tool.schema
        .number()
        .optional()
        .describe("Seconds to wait synchronously (default 30). On expiry the task is interrupted unless on_timeout=detach."),
      on_timeout: tool.schema
        .enum(["interrupt", "detach"])
        .optional()
        .describe('What happens at timeout_s expiry (default from pyrepl.jsonc on_timeout): "interrupt" stops the task and returns partial output, "detach" lets it keep running and returns a task_id.'),
      preempt: tool.schema
        .boolean()
        .optional()
        .describe("If true and another task is running, interrupt it first and run this code right after. Fails as preempt_failed when the running task ignores the interrupt (signal-immune); re-init to respawn then."),
      progress_s: tool.schema
        .number()
        .optional()
        .describe("Interim still-running notice cadence in seconds for this task (default off). The completion notice still fires separately; notices never dump output."),
    },
    async execute(args, context: ToolContext) {
      context.metadata({ title: "pyrepl exec" })
      const key = context.sessionID
      // Single file read per call: the loaded config feeds timeout/bin
      // selection AND the session (no second stat+parse inside ensure).
      const loaded = await loadMergedConfig(context)
      const rawTimeout = args.timeout_s as number | undefined
      const timeoutS =
        Number.isFinite(rawTimeout) && (rawTimeout as number) > 0 ? (rawTimeout as number) : loaded.config.timeout_s
      const waitMs = Math.max(100, Math.floor(timeoutS * 1000))
      // Never re-resolve over a live session: the interpreter chosen by
      // pyrepl_init (or the first auto-init) sticks until the process dies.
      const live = sessions.get(key)
      let bin = live && !live.dead ? live.bin : await resolveBin(undefined, context, loaded.config)
      let { session, note } = await ensureSession(key, bin, context, loaded)
      if (session.dead) {
        const revived = await respawnIfDead(key, session, context)
        session = revived.session
        note = revived.note
      }
      const freshNote = consumeFreshNote(session, note, args.reset)
      if (args.reset) {
        try {
          const rr = await rpc(session, { op: "reset" }, session.config.rpc_timeout_ms)
          if (rr?.status === "busy") {
            const busyId = rr?.task_id ? ` (task_id=${rr.task_id})` : ""
            return `reset refused: a task is still running${busyId}. Call pyrepl_interrupt first, then retry with reset=true.`
          }
        } catch (e) {
          killSession(session)
          sessions.delete(key)
          const created = await ensureSession(key, session.bin, context)
          session = created.session
        }
        session.execCount = 0
        // Task ids restart at t_1 alongside exec numbers (the server
        // drops its registry on reset; busy replies never consume an
        // id, see below), so t_N always means exec #N and Out[N].
        // Forget delivery bookkeeping with them to avoid waking the
        // agent with stale pre-reset output under a recycled id.
        session.taskSeq = 0
        session.resetSeq += 1
        session.consumed.clear()
        session.notified.clear()
        pendingNotify.delete(key)
      }
      session.taskSeq += 1
      const taskId = `t_${session.taskSeq}`
      const outcome = await rpcAbortable(
        session,
        {
          op: "execute",
          task_id: taskId,
          code: args.code,
          wait_ms: waitMs,
          preempt: args.preempt ?? false,
          on_timeout: args.on_timeout ?? session.config.on_timeout,
        },
        waitMs + session.config.wait_grace_ms,
        context.abort,
      )
      if (outcome.aborted) {
        return `wait aborted by caller; task ${taskId} is still running. Use pyrepl_read to poll it or pyrepl_interrupt to stop it.`
      }
      const res = outcome.value
      if (res?.status === "busy" || res?.status === "preempt_failed") {
        // The server created nothing for these replies, so take the
        // pre-armed id back. t_N then always means exec #N (Out[N]
        // stays the single visible counter).
        session.taskSeq -= 1
      }
      if (args.reset) session.execCount = res?.n ?? 0
      const canNotify = session.config.notify_agent && deps.client !== null
      if (res?.status === "running" && res?.task_id) {
        // Background task: wake the agent here on completion so it does
        // not have to poll. The waiter exits silently if the output
        // reaches the agent first via pyrepl_read/pyrepl_interrupt.
        if (res?.preempted) session.consumed.add(res.preempted.task_id)
        const progressS = args.progress_s ?? session.config.notify_progress_s
        if (canNotify && deps.client) {
          void notifyWhenDone(deps.client, key, res.task_id, context.agent || undefined, progressS)
        }
        const out = formatExecResult(res, session, freshNote)
        return canNotify
          ? `${out}\n<pyrepl>\nI will notify you in this session when task ${res.task_id} finishes; polling with pyrepl_read is optional\n<pyrepl>`
          : out
      }
      if (res?.task_id) session.consumed.add(res.task_id)
      // A preempted task ended without its output reaching the agent
      // inline; suppress the stale wake-up its old waiter may deliver.
      if (res?.preempted) session.consumed.add(res.preempted.task_id)
      return formatExecResult(res, session, freshNote)
    },
  })
}
