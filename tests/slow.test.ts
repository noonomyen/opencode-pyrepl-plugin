/** Slow timing-sensitive suites: notifications, progress, death, CPU kill,
 * EOF races. Runs every PR (budget ~4 min). Run: bun test tests/slow.test.ts
 */
import { test, expect, afterAll } from "bun:test"
import { spawn } from "node:child_process"
import { ProcClient, SERVER_FILE, fakeCtx, loadPlugin, sleep } from "./helpers.ts"

const SLOW_SESSIONS = [
  "slow-sess-sleep",
  "slow-sess-notify",
  "slow-sess-readfirst",
  "slow-sess-idleflush",
  "slow-sess-death",
  "slow-sess-progress",
]

afterAll(async () => {
  const hooks: any = await loadPlugin()
  for (const id of SLOW_SESSIONS) {
    try {
      await hooks.event({ event: { type: "session.deleted", properties: { info: { id } } } })
    } catch {
    }
  }
})

test("long sleep finishes, readable after", async () => {
  const hooks: any = await loadPlugin()
  const ctx = fakeCtx("slow-sess-sleep")
  const r: string = await hooks.tool.pyrepl_exec.execute(
    { code: "import time\ntime.sleep(5)\nprint('done-sleep')", timeout_s: 1 }, ctx)
  const m = r.match(/task (t_\d+)/)
  expect(r).toContain("running")
  expect(m).not.toBeNull()
  const deadline = Date.now() + 15000
  let rd = ""
  for (;;) {
    rd = await hooks.tool.pyrepl_read.execute({ task_id: m![1] }, ctx)
    if (rd.includes(`task ${m![1]}: done`) || Date.now() >= deadline) break
    await sleep(500)
  }
  expect(rd).toContain(`task ${m![1]}: done`)
  expect(rd).toContain("done-sleep")
}, 30000)

test("agent notified on background completion, then notify-once", async () => {
  const prompts: any[] = []
  const hooks: any = await loadPlugin({
    client: { session: { promptAsync: async (o: any) => { prompts.push(o); return {} } } },
  })
  const ctx = fakeCtx("slow-sess-notify")
  const r: string = await hooks.tool.pyrepl_exec.execute(
    { code: "import time\ntime.sleep(3)\nprint('notify-marker-1')", timeout_s: 1 }, ctx)
  const m = r.match(/task (t_\d+)/)
  expect(r).toContain("notify you")
  const t0 = Date.now()
  while (prompts.length === 0 && Date.now() - t0 < 20000) await sleep(500)
  expect(prompts.length).toBe(1)
  const notice = prompts[0]?.body?.parts?.[0]?.text ?? ""
  expect(prompts[0]?.path?.id).toBe("slow-sess-notify")
  expect(prompts[0]?.body?.agent).toBe("build")
  expect(notice).toContain(`task_id=${m![1]}`)
  expect(notice).not.toContain("exec #")
  expect(notice).toMatch(/elapsed=[\d.]+ms/)
  expect(notice).toContain(`pyrepl_read task_id=${m![1]}`)
  expect(notice).not.toContain("notify-marker-1")
  await hooks.tool.pyrepl_read.execute({ task_id: m![1] }, ctx)
  // One 5s waiter poll is not enough to prove notify-once; wait out two.
  await sleep(12000)
  const doneNotices = prompts.filter((p) =>
    (p?.body?.parts?.[0]?.text ?? "").includes("background task done"),
  )
  expect(doneNotices.length).toBe(1)
}, 45000)

test("read-first suppresses the wake-up", async () => {
  const prompts: any[] = []
  const hooks: any = await loadPlugin({
    client: { session: { promptAsync: async (o: any) => { prompts.push(o); return {} } } },
  })
  const ctx = fakeCtx("slow-sess-readfirst")
  const r: string = await hooks.tool.pyrepl_exec.execute(
    { code: "import time\ntime.sleep(2)\nprint('notify-marker-2')", timeout_s: 1 }, ctx)
  const m = r.match(/task (t_\d+)/)
  await sleep(2600)
  const rd: string = await hooks.tool.pyrepl_read.execute({ task_id: m![1] }, ctx)
  expect(rd).toContain("notify-marker-2")
  // Cover two waiter polls so a late wake-up cannot hide behind timing.
  await sleep(12000)
  expect(prompts.length).toBe(0)
}, 35000)

test("failed prompt retries on session.idle", async () => {
  let busyCalls = 0
  const idlePrompts: any[] = []
  const hooks: any = await loadPlugin({
    client: {
      session: {
        promptAsync: async (o: any) => {
          busyCalls++
          if (busyCalls === 1) throw new Error("session busy")
          idlePrompts.push(o)
          return {}
        },
      },
    },
  })
  const ctx = fakeCtx("slow-sess-idleflush")
  await hooks.tool.pyrepl_exec.execute(
    { code: "import time\ntime.sleep(2)\nprint('notify-marker-3')", timeout_s: 1 }, ctx)
  const t0 = Date.now()
  // The first prompt attempt only happens at a waiter poll (>=5s), by
  // which time the 2s task is terminal, so the idle flush below always
  // resolves a finished task. Do NOT read the task first: that would mark
  // it consumed and the waiter would exit before attempting anything.
  while (busyCalls === 0 && Date.now() - t0 < 20000) await sleep(500)
  expect(busyCalls).toBeGreaterThanOrEqual(1)
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "slow-sess-idleflush" } } })
  expect(idlePrompts.length).toBe(1)
  const text = idlePrompts[0]?.body?.parts?.[0]?.text ?? ""
  expect(text).toContain("pyrepl_read task_id=")
  expect(text).not.toContain("notify-marker-3")
}, 40000)

test("server death mid-task notifies, next exec respawns fresh", async () => {
  const prompts: any[] = []
  const hooks: any = await loadPlugin({
    client: { session: { promptAsync: async (o: any) => { prompts.push(o); return {} } } },
  })
  const ctx = fakeCtx("slow-sess-death")
  const before = prompts.length
  await hooks.tool.pyrepl_exec.execute(
    {
      code: "import threading, time, os\nthreading.Thread(target=lambda: (time.sleep(1.5), os._exit(1)), daemon=True).start()\nimport time as _t\n_t.sleep(30)",
      timeout_s: 1,
    },
    ctx,
  )
  const t0 = Date.now()
  while (prompts.length === before && Date.now() - t0 < 25000) await sleep(500)
  expect(prompts.length).toBe(before + 1)
  const death = prompts[prompts.length - 1]?.body?.parts?.[0]?.text ?? ""
  expect(death).toContain("lost")
  expect(death).toContain("died")
  const r: string = await hooks.tool.pyrepl_exec.execute({ code: "1 + 1" }, ctx)
  expect(r).toContain("<pyrepl>")
  expect(r).toContain("Out[1]: 2")
}, 45000)

test("progress_s sends interim notices, completion still fires", async () => {
  const prompts: any[] = []
  const hooks: any = await loadPlugin({
    client: { session: { promptAsync: async (o: any) => { prompts.push(o); return {} } } },
  })
  const ctx = fakeCtx("slow-sess-progress")
  const r: string = await hooks.tool.pyrepl_exec.execute(
    { code: "import time\ntime.sleep(7)\nprint('pg-done')", timeout_s: 1, progress_s: 2 }, ctx)
  const m = r.match(/task (t_\d+)/)
  const t0 = Date.now()
  while (prompts.length < 2 && Date.now() - t0 < 25000) await sleep(500)
  expect(prompts.length).toBeGreaterThanOrEqual(2)
  const interim = prompts[0]?.body?.parts?.[0]?.text ?? ""
  const last = prompts[prompts.length - 1]?.body?.parts?.[0]?.text ?? ""
  expect(interim).toContain("still running")
  expect(interim).not.toContain("pg-done")
  expect(last).toContain("background task done")
  expect(last).toContain(m![1])
}, 35000)

test("CPU cap kills runaway, server exits", async () => {
  const c = new ProcClient({ PYREPL_MAX_CPU_S: "1" })
  try {
    const pending = c.call(
      { op: "execute", task_id: "t_hot", wait_ms: 30000, code: "while True:\n    pass" }, 15000)
    pending.catch(() => {})
    await sleep(500)
    // Exit event (not kill(pid,0): true for zombies too). RLIMIT_CPU needs
    // real burn time; throttled CI gets a 30s budget.
    const exited = await Promise.race([
      c.exited.then(() => true),
      sleep(30000).then(() => false),
    ])
    expect(exited).toBe(true)
    await pending.catch(() => {})
  } finally {
    try {
      c.proc.kill("SIGKILL")
    } catch {
    }
  }
}, 60000)

test("EOF mid-wait still answers in-flight execute", async () => {
  // Pipe order is FIFO (execute bytes always precede EOF), so the server
  // deterministically enters the wait before seeing EOF. Await 'close'
  // rather than 'exit': all piped bytes are delivered by close time.
  const p = spawn("python3", [SERVER_FILE], { stdio: ["pipe", "pipe", "pipe"] })
  const lines: any[] = []
  let out = ""
  p.stdout!.on("data", (ch: unknown) => { out += String(ch) })
  p.stdin!.write(JSON.stringify({ id: 1, op: "execute", task_id: "t_eof", code: "import time\ntime.sleep(30)", wait_ms: 60000 }) + "\n")
  await sleep(1000)
  p.stdin!.end()
  const closed = await new Promise<boolean>((resolve) => {
    const t = setTimeout(() => resolve(false), 15000)
    p.on("close", () => {
      clearTimeout(t)
      resolve(true)
    })
  })
  expect(closed).toBe(true)
  for (const l of out.split("\n")) {
    if (!l.trim()) continue
    try {
      lines.push(JSON.parse(l))
    } catch {
    }
  }
  const resp = lines.filter((m) => m.id === 1)
  expect(resp.length).toBe(1)
  expect(resp[0].status).toBe("running")
  expect(resp[0].task_id).toBe("t_eof")
}, 30000)
