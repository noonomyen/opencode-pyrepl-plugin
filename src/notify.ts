import { DEFAULT_CONFIG } from "./config.ts"
import {
  formatCompletionNotice,
  formatDeathNotice,
  formatLostNotice,
} from "./format.ts"
import { rpc } from "./rpc.ts"
import { isTerminalTaskStatus, pendingNotify, sessions } from "./session.ts"
import type { NotifyClient, TaskListEntry, TaskListResponse } from "./types.ts"

export function extractSessionId(props: Record<string, any>): string | undefined {
  const id: unknown = props.info?.id ?? props.sessionID ?? props.sessionId ?? props.id
  return typeof id === "string" ? id : undefined
}

// Park a wake-up for retry on the next session.idle event.
function parkNotify(key: string, taskId: string, agent: string | undefined): void {
  let set = pendingNotify.get(key)
  if (!set) {
    set = new Map()
    pendingNotify.set(key, set)
  }
  set.set(taskId, agent)
}

// Push a prebuilt text into the agent's session. promptAsync admits the
// message even mid-turn (the running turn picks it up next step); on
// admission failure park it for retry on the next session.idle event.
// Returns true when the message was admitted.
export async function pushText(
  client: NotifyClient,
  key: string,
  taskId: string,
  agent: string | undefined,
  text: string,
  markNotified = true,
): Promise<boolean> {
  try {
    await client.session.promptAsync({
      path: { id: key },
      body: {
        parts: [{ type: "text", text, synthetic: true }],
        ...(agent ? { agent } : {}),
      },
    })
    if (markNotified) sessions.get(key)?.notified.add(taskId)
    return true
  } catch {
    parkNotify(key, taskId, agent)
    return false
  }
}

// Notify that a background task finished. The parked queue stores only the
// agent per task: a parked task whose session is dead by flush time is
// reported as lost instead of completed.
export async function deliverCompletion(
  client: NotifyClient,
  key: string,
  taskId: string,
  agent: string | undefined,
): Promise<void> {
  const session = sessions.get(key)
  if (!session || session.dead) {
    await pushText(client, key, taskId, agent, formatDeathNotice(taskId))
    return
  }
  if (session.consumed.has(taskId) || session.notified.has(taskId)) return
  try {
    const res = await rpc(
      session,
      { op: "read", task_id: taskId, offset: 0, limit: 200, grep: null, target: "combined", tail_lines: null },
      session.config.rpc_timeout_ms,
    )
    if (res?.status === "not_found") {
      await pushText(client, key, taskId, agent, formatLostNotice(taskId))
      return
    }
    if (res?.status === "error") return
    // A parked entry resolved while the task still runs (e.g. a stale
    // retry): the active waiter owns completion, drop the park.
    if (!isTerminalTaskStatus(res.status)) return
    await pushText(client, key, taskId, agent, formatCompletionNotice(taskId, res))
  } catch {
    parkNotify(key, taskId, agent)
  }
}

// Fire-and-forget waiter armed when exec returns a running task. Exits
// silently when the output already reached the agent another way, or when
// the session was replaced/reset under it (generation guard: never watch
// a recycled task id).
export async function notifyWhenDone(
  client: NotifyClient,
  key: string,
  taskId: string,
  agent: string | undefined,
): Promise<void> {
  const armed = sessions.get(key)
  const armedSeq = armed?.resetSeq ?? -1
  let listFails = 0
  try {
    for (;;) {
      const pollMs = sessions.get(key)?.config.notify_poll_ms ?? DEFAULT_CONFIG.notify_poll_ms
      await new Promise((res) => setTimeout(res, pollMs))
      const session = sessions.get(key)
      if (!session || session !== armed || session.resetSeq !== armedSeq) return
      if (session.consumed.has(taskId) || session.notified.has(taskId)) return
      if (session.dead) {
        await deliverCompletion(client, key, taskId, agent)
        return
      }
      let found: TaskListEntry | undefined
      try {
        const res = await rpc<TaskListResponse>(session, { op: "list" }, session.config.rpc_timeout_ms)
        found = res?.tasks?.find((t) => t.task_id === taskId)
      } catch {
        // The list RPC itself failed: only a dead server is conclusive
        // (deliverCompletion reports it lost); a live one may be transient,
        // so keep polling instead of waking the agent wrongly. Give up
        // after 12 consecutive failures so a wedged pipe cannot park
        // a waiter forever (wall time depends on notify_poll_ms).
        if (session.dead) {
          await deliverCompletion(client, key, taskId, agent)
          return
        }
        listFails += 1
        if (listFails >= 12) return
        continue
      }
      listFails = 0
      if (!found || isTerminalTaskStatus(found.task_status)) break
    }
    await deliverCompletion(client, key, taskId, agent)
  } catch {
  }
}

export async function flushPendingNotify(client: NotifyClient, key: string): Promise<void> {
  const set = pendingNotify.get(key)
  if (!set || set.size === 0) return
  pendingNotify.delete(key)
  if (!sessions.get(key)) return
  // Fan out in parallel: one slow RPC (up to rpc_timeout_ms) must not
  // head-of-line-block the rest of the parked tasks.
  await Promise.allSettled(
    [...set].map(([taskId, agent]) => deliverCompletion(client, key, taskId, agent)),
  )
}
