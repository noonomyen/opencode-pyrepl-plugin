import type { NotifyClient } from "../types.ts"

// Shared guidance appended to every tool description: the plugin has no
// plugin-level description field, so cross-tool rules ride on each tool.
// Kept terse: tool outputs are read by the agent, not humans.
export const GUIDE =
  " Single-flight: never call exec/init in parallel with a reset exec;" +
  " a second exec returns busy (read or interrupt the running task, then retry, or exec with preempt=true);" +
  " init with a different bin is refused while a task runs (interrupt first); same-bin init preserves state." +
  " Prefer define-once/call-many, end code with a bare expression to see its value instead of printing," +
  " print sparingly (finished tasks keep values, not output lines), set timeout_s per attempt," +
  " reset when switching problems, check pyrepl_vars before trusting old names."

export type ToolDeps = {
  client: NotifyClient | null
}

// Clamp user seconds into a sane range so a NaN/Inf/negative can never
// wedge an RPC wait on either side of the protocol.
export function clampWaitS(v: number | undefined): number {
  if (!Number.isFinite(v ?? NaN)) return 5
  return Math.min(300, Math.max(1, Math.floor(v as number)))
}
