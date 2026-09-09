/** Tool-level tests: drive the TS plugin tools with a fake context.
 * Fast subset (no long sleeps); timing-sensitive flows live in slow.test.ts.
 * Run: bun test tests/tools.test.ts
 */
import { test, expect } from "bun:test"
import { fakeCtx, loadPlugin, sleep } from "./helpers.ts"

const hooks: any = await loadPlugin()
const t = hooks.tool

// NOTE: tools-sess-1 is intentionally shared across the first tests in file
// order (fresh note -> state persist -> reset). bun:test runs file order;
// do not reorder or parallelize these.
test("exec auto-inits with fresh note and result", async () => {
  const ctx = fakeCtx("tools-sess-1")
  const r: string = await t.pyrepl_exec.execute({ code: "x = 41\nx + 1" }, ctx)
  expect(r).toContain("<pyrepl>")
  expect(r).toContain("fresh")
  expect(r).toContain("Out[1]: 42")
})

test("second exec has no fresh note, state persists", async () => {
  const ctx = fakeCtx("tools-sess-1")
  const r: string = await t.pyrepl_exec.execute({ code: "x * 2" }, ctx)
  expect(r).not.toContain("<pyrepl>")
  expect(r).toContain("Out[2]: 82")
})

test("print and error paths", async () => {
  const ctx = fakeCtx("tools-sess-1")
  const r: string = await t.pyrepl_exec.execute({ code: "print('hello')\n1/0" }, ctx)
  expect(r).toContain("hello")
  expect(r).toContain("ZeroDivisionError")
})

test("reset is single-step and wipes state", async () => {
  const ctx = fakeCtx("tools-sess-1")
  const r: string = await t.pyrepl_exec.execute({ code: "z = 1\nz", reset: true }, ctx)
  expect(r).toContain("Out[1]: 1")
  expect(r).not.toContain("<pyrepl>")
  const r2: string = await t.pyrepl_exec.execute({ code: "y" }, ctx)
  expect(r2).toContain("NameError")
})

test("interrupt stops a python loop", async () => {
  const ctx = fakeCtx("tools-sess-loop")
  const r: string = await t.pyrepl_exec.execute(
    { code: "i = 0\nwhile True:\n    i += 1", timeout_s: 1, on_timeout: "detach" }, ctx)
  expect(r).toMatch(/status: running \(task (t_\d+)\)/)
  const m = r.match(/task (t_\d+)/)
  expect(m).not.toBeNull()
  const ri: string = await t.pyrepl_interrupt.execute({ task_id: m![1] }, ctx)
  expect(ri).toContain("interrupted")
  expect(ri).toContain("KeyboardInterrupt")
}, 15000)

test("timeout interrupts by default, detaches on request", async () => {
  const ctx = fakeCtx("tools-sess-ontimeout")
  const r: string = await t.pyrepl_exec.execute({ code: "import time\ntime.sleep(30)", timeout_s: 1 }, ctx)
  expect(r).toContain("KeyboardInterrupt")
  expect(r).not.toContain("status: running")
  const ctx2 = fakeCtx("tools-sess-ontimeout2")
  const r2: string = await t.pyrepl_exec.execute(
    { code: "import time\ntime.sleep(30)", timeout_s: 1, on_timeout: "detach" }, ctx2)
  expect(r2).toMatch(/status: running \(task (t_\d+)\)/)
  const m = r2.match(/task (t_\d+)/)
  await t.pyrepl_interrupt.execute({ task_id: m![1] }, ctx2)
}, 30000)

test("read grep filters live output, drop note after finish", async () => {
  const ctx = fakeCtx("tools-sess-grep")
  const r: string = await t.pyrepl_exec.execute(
    { code: "import time\nfor i in range(3):\n    print(f'row-{i}')\ntime.sleep(30)", timeout_s: 1, on_timeout: "detach" },
    ctx,
  )
  expect(r).toContain("task t_1")
  const hit: string = await t.pyrepl_read.execute({ task_id: "t_1", grep: "row-[12]" }, ctx)
  expect(hit).toContain("task t_1: running")
  expect(hit).toContain("row-1")
  expect(hit).toContain("row-2")
  expect(hit).not.toContain("row-0")
  const miss: string = await t.pyrepl_read.execute({ task_id: "t_1", grep: "zzz-no-match" }, ctx)
  expect(miss).toContain("task t_1: running")
  expect(miss).not.toContain("row-")
  await t.pyrepl_interrupt.execute({ task_id: "t_1" }, ctx)
  const done: string = await t.pyrepl_read.execute({ task_id: "t_1" }, ctx)
  expect(done).toContain("task t_1: interrupted")
  expect(done).toContain("dropped when the task finished")
}, 30000)

test("sessions are isolated with own fresh state", async () => {
  const r: string = await t.pyrepl_exec.execute({ code: "x" }, fakeCtx("tools-sess-2"))
  expect(r).toContain("<pyrepl>")
  expect(r).toContain("NameError")
})

test("init rejects a bad interpreter", async () => {
  const r: string = await t.pyrepl_init
    .execute({ bin_path: "/nonexistent/python" }, fakeCtx("tools-sess-3"))
    .catch((e: Error) => "THREW: " + e.message)
  expect(r).toContain("not usable")
})

test("explicit init notes fresh session on first exec", async () => {
  const ctx = fakeCtx("tools-sess-4")
  expect(await t.pyrepl_init.execute({ bin_path: "/usr/bin/python3" }, ctx)).toContain("REPL ready")
  expect(await t.pyrepl_exec.execute({ code: "1+1" }, ctx)).toContain("<pyrepl>")
})

test("init bin sticks across exec", async () => {
  const ctx = fakeCtx("tools-sess-bin")
  expect(await t.pyrepl_init.execute({ bin_path: "/usr/bin/python3" }, ctx)).toContain("/usr/bin/python3")
  expect(await t.pyrepl_exec.execute({ code: "binvar = 123\nbinvar" }, ctx)).toContain("Out[1]: 123")
  expect(await t.pyrepl_init.execute({ bin_path: "/usr/bin/python3" }, ctx)).toContain("already running on /usr/bin/python3")
  expect(await t.pyrepl_exec.execute({ code: "binvar" }, ctx)).toContain("Out[2]: 123")
})

test("head+tail preview keeps both ends", async () => {
  const ctx = fakeCtx("tools-sess-headtail")
  const r: string = await t.pyrepl_exec.execute(
    { code: "for i in range(120):\n    print(f'line-{i:03d}-' + 'x' * 90)\nprint('END-MARKER-XYZ')" },
    ctx,
  )
  expect(r).toContain("END-MARKER-XYZ")
  expect(r).toContain("line-000")
})

test("reset unifies task id and exec number", async () => {
  const ctx = fakeCtx("tools-sess-ids")
  await t.pyrepl_exec.execute({ code: "1" }, ctx)
  await t.pyrepl_exec.execute({ code: "2" }, ctx)
  const r: string = await t.pyrepl_exec.execute({ code: "3", reset: true }, ctx)
  expect(r).toContain("Out[1]: 3")
  const rd: string = await t.pyrepl_read.execute({ task_id: "t_1" }, ctx)
  expect(rd).toContain("task t_1: done")
  expect(rd).toContain("Out[1]: 3")
  expect(rd).not.toContain("exec #")
})

test("big result retrievable via read target=result", async () => {
  const ctx = fakeCtx("tools-sess-full")
  const r: string = await t.pyrepl_exec.execute({ code: "[i for i in range(3000)]" }, ctx)
  expect(r).toContain("2999]")
  expect(r).toContain("target=result")
  const rd: string = await t.pyrepl_read.execute({ task_id: "t_1", target: "result" }, ctx)
  expect(rd).toContain("[0, 1, 2")
  expect(rd).toContain("2999]")
})

test("status is a paramless health snapshot", async () => {
  const ctx = fakeCtx("tools-sess-status")
  expect(await t.pyrepl_status.execute({}, ctx)).toContain("no REPL session")
  await t.pyrepl_exec.execute({ code: "sv = 1" }, ctx)
  const st: string = await t.pyrepl_status.execute({}, ctx)
  expect(st).toContain("exec count 1")
  expect(st).toContain("limits: mem=")
  expect(st).toContain("rss=")
  expect(st).toContain("cwd=")
  expect(st).toContain("idle: no task running")
})

test("tasks lists history, singles out one task, appends vars", async () => {
  const ctx = fakeCtx("tools-sess-tasks")
  await t.pyrepl_exec.execute({ code: "tv_watch = [1, 2]\ntv_watch" }, ctx)
  const hist: string = await t.pyrepl_tasks.execute({ limit: 5 }, ctx)
  expect(hist).toContain("recent (last 1):")
  expect(hist).toContain("- t_1: done wall=")
  expect(hist).toContain("vars (")
  expect(hist).toContain("tv_watch: list")
  const one: string = await t.pyrepl_tasks.execute({ task_id: "t_1" }, ctx)
  expect(one).toContain("task t_1: done")
  expect(await t.pyrepl_tasks.execute({ task_id: "t_nope" }, ctx)).toContain("unknown task")
  expect(await t.pyrepl_tasks.execute({ filter: "failed" }, ctx)).toContain("no matching tasks")
})

test("vars lists and inspects", async () => {
  const ctx = fakeCtx("tools-sess-vars")
  await t.pyrepl_exec.execute({ code: "vv_big = list(range(10))\nvv_s = 3" }, ctx)
  const li: string = await t.pyrepl_vars.execute({ pattern: "^vv_" }, ctx)
  expect(li).toContain("vv_big: list")
  expect(li).toContain("vv_s: int")
  const big: string = await t.pyrepl_vars.execute({ sort: "size", limit: 3 }, ctx)
  expect(big).toContain("vv_big")
  const one: string = await t.pyrepl_vars.execute({ name: "vv_big" }, ctx)
  expect(one).toContain("[0, 1, 2")
  expect(one).toContain("9]")
  expect(await t.pyrepl_vars.execute({ name: "vv_nope" }, ctx)).toContain("unknown variable")
})

test("reset while busy names the task", async () => {
  const ctx = fakeCtx("tools-sess-busyreject")
  const execP = t.pyrepl_exec.execute({ code: "while True:\n    pass", timeout_s: 30, on_timeout: "detach" }, ctx)
  execP.catch(() => {})
  const deadline = Date.now() + 15000
  for (;;) {
    const st: string = await t.pyrepl_status.execute({}, ctx)
    if (st.includes("running: task t_1")) break
    if (Date.now() >= deadline) throw new Error("task never reached running")
    await sleep(200)
  }
  const r: string = await t.pyrepl_exec.execute({ code: "x = 1", reset: true }, ctx)
  expect(r).toContain("reset refused")
  expect(r).toContain("t_1")
  await t.pyrepl_interrupt.execute({ task_id: "t_1" }, ctx)
  await execP
}, 60000)

test("repr failure keeps a placeholder value", async () => {
  const r: string = await t.pyrepl_exec.execute(
    { code: "class Bad:\n    def __repr__(self):\n        raise RuntimeError('boom')\nBad()" },
    fakeCtx("tools-sess-repr"),
  )
  expect(r).toContain("<repr failed: Bad>")
})

test("orphan hint when bg output lands between tasks", async () => {
  const ctx = fakeCtx("tools-sess-orphanhint")
  await t.pyrepl_exec.execute(
    { code: "import threading, time\nthreading.Thread(target=lambda: (time.sleep(0.05), print('BG-GAP')), daemon=True).start()\nprint('quick')" },
    ctx,
  )
  // Fixed sleep (not a read poll): any read would advance the orphan
  // watermark and eat the hint the second exec must show. 1s is 20x the
  // 50ms bg delay.
  await sleep(1000)
  const r: string = await t.pyrepl_exec.execute({ code: "print('main-done')" }, ctx)
  expect(r).toContain("target=orphan")
  expect(r).toContain("main-done")
}, 20000)

test("session.deleted respawns fresh", async () => {
  const ctx = fakeCtx("tools-sess-doomed")
  await t.pyrepl_exec.execute({ code: "doomed_var = 1" }, ctx)
  await (hooks as any).event({ event: { type: "session.deleted", properties: { info: { id: "tools-sess-doomed" } } } })
  const r: string = await t.pyrepl_exec.execute({ code: "doomed_var" }, ctx)
  expect(r).toContain("<pyrepl>")
  expect(r).toContain("NameError")
})

test("busy replies consume no id", async () => {
  const ctx = fakeCtx("tools-sess-unified")
  const r: string = await t.pyrepl_exec.execute(
    { code: "while True:\n    pass", timeout_s: 1, on_timeout: "detach" }, ctx)
  const m = r.match(/task (t_\d+)/)
  expect(m?.[1]).toBe("t_1")
  expect(r).not.toContain("exec #")
  const busy: string = await t.pyrepl_exec.execute({ code: "9 + 9" }, ctx)
  expect(busy).toContain("busy")
  expect(busy).toContain("t_1")
  await t.pyrepl_interrupt.execute({ task_id: "t_1" }, ctx)
  const r2: string = await t.pyrepl_exec.execute({ code: "40 + 2" }, ctx)
  expect(r2).toContain("Out[2]: 42")
  const rd: string = await t.pyrepl_read.execute({ task_id: "t_2" }, ctx)
  expect(rd).toContain("task t_2: done")
  expect(rd).toContain("Out[2]: 42")
  expect(await t.pyrepl_read.execute({ task_id: "t_3" }, ctx)).toContain("unknown task")
}, 20000)

test("every exec ends with a resource one-liner", async () => {
  const r: string = await t.pyrepl_exec.execute(
    { code: "m = [i for i in range(1000)]\nlen(m)" }, fakeCtx("tools-sess-metrics"))
  expect(r).toMatch(/^\[resources: wall=[\d.]+ms( cpu=[\d.]+ms)?( alloc=[+-]?[\d.]+(B|KB|MB|GB))?( peak=[+-]?[\d.]+(B|KB|MB|GB)(\/\d+MB)?)? vars=\d+\]$/m)
  expect(r).not.toContain("exec #")
})

test("preempt interrupts the running task and runs new code", async () => {
  const ctx = fakeCtx("tools-sess-preempt")
  const r: string = await t.pyrepl_exec.execute(
    { code: "while True:\n    pass", timeout_s: 1, on_timeout: "detach" }, ctx)
  expect(r).toContain("task t_1")
  const r2: string = await t.pyrepl_exec.execute({ code: "40 + 2", preempt: true }, ctx)
  expect(r2).toContain("Out[2]: 42")
  expect(r2).toContain("[preempted t_1 (interrupted)]")
  expect(await t.pyrepl_read.execute({ task_id: "t_1" }, ctx)).toContain("task t_1: interrupted")
}, 20000)

test("alloc goes negative when the task frees memory", async () => {
  const ctx = fakeCtx("tools-sess-alloc")
  await t.pyrepl_exec.execute({ code: "tmp = bytearray(5 * 1024 * 1024)" }, ctx)
  const r: string = await t.pyrepl_exec.execute({ code: "del tmp\n0" }, ctx)
  expect(r).toMatch(/alloc=-\d+(\.\d+)?(B|KB|MB)/)
})

test("KeyboardInterrupt-swallowing tight loop still dies (edge delivery)", async () => {
  const ctx = fakeCtx("tools-sess-killswallow")
  const r: string = await t.pyrepl_exec.execute(
    { code: "i = 0\nwhile True:\n    try:\n        i += 1\n    except KeyboardInterrupt:\n        continue", timeout_s: 1, on_timeout: "detach" }, ctx)
  const m = r.match(/task (t_\d+)/)
  expect(m).not.toBeNull()
  const t0 = Date.now()
  const rk: string = await t.pyrepl_interrupt.execute({ task_id: m![1] }, ctx)
  expect(rk).toContain("interrupted")
  expect(rk).toContain("KeyboardInterrupt")
  expect(Date.now() - t0).toBeLessThan(8000)
}, 25000)

test("interrupt wait_s bounds swallowing loops, kill ends them", async () => {
  const ctx = fakeCtx("tools-sess-waits")
  const r: string = await t.pyrepl_exec.execute(
    { code: "while True:\n    try:\n        while True:\n            x = 1\n    except BaseException:\n        continue", timeout_s: 1, on_timeout: "detach" }, ctx)
  const m = r.match(/task (t_\d+)/)
  expect(m).not.toBeNull()
  const t0 = Date.now()
  const rw: string = await t.pyrepl_interrupt.execute({ task_id: m![1], wait_s: 1 }, ctx)
  expect(rw).toContain("running")
  expect(Date.now() - t0).toBeLessThan(8000)
  expect(rw).toContain("mode=kill")
  const rk: string = await t.pyrepl_interrupt.execute({ task_id: m![1], mode: "kill" }, ctx)
  expect(rk).toContain("killed")
  const r2: string = await t.pyrepl_exec.execute({ code: "40 + 2" }, ctx)
  expect(r2).toContain("Out[1]: 42")
}, 30000)

test("kill on a finished task does not wipe the session", async () => {
  const ctx = fakeCtx("tools-sess-killfinished")
  await t.pyrepl_exec.execute({ code: "kv_keep = 7" }, ctx)
  const rk: string = await t.pyrepl_interrupt.execute({ task_id: "t_1", mode: "kill" }, ctx)
  expect(rk).toContain("already finished")
  // Session object untouched: state survives, no respawn note.
  const r2: string = await t.pyrepl_exec.execute({ code: "kv_keep * 2" }, ctx)
  expect(r2).toContain("Out[2]: 14")
  expect(r2).not.toContain("<pyrepl>")
}, 30000)

test("init fails closed when the server stops responding", async () => {
  const { sessions } = await import("../src/session.ts")
  const ctx = fakeCtx("tools-sess-initwedged")
  await t.pyrepl_exec.execute({ code: "1" }, ctx)
  // Wedge the pipe, then pin the race window: the exit event may or may
  // not have propagated, but the list RPC cannot be answered either way.
  const sess = sessions.get("tools-sess-initwedged")
  sess?.proc.kill("SIGKILL")
  await sleep(500)
  if (sess) sess.dead = false
  const r: string = await t.pyrepl_init.execute({ bin_path: "/usr/bin/python3" }, ctx)
  expect(r).toContain("not responding")
  expect(r).not.toContain("REPL ready")
  await (hooks as any).event({ event: { type: "session.deleted", properties: { info: { id: "tools-sess-initwedged" } } } })
}, 30000)

test("init with different bin refused while running", async () => {
  const ctx = fakeCtx("tools-sess-initrefuse")
  const execP = t.pyrepl_exec.execute(
    { code: "while True:\n    pass", timeout_s: 30, on_timeout: "detach" }, ctx)
  execP.catch(() => {})
  const deadline = Date.now() + 15000
  for (;;) {
    const st: string = await t.pyrepl_status.execute({}, ctx)
    if (st.includes("running: task t_1")) break
    if (Date.now() >= deadline) throw new Error("task never reached running")
    await sleep(200)
  }
  const refused: string = await t.pyrepl_init.execute({ bin_path: "/usr/bin/python3" }, ctx)
  expect(refused).toContain("init refused")
  expect(refused).toContain("t_1")
  await t.pyrepl_interrupt.execute({ task_id: "t_1" }, ctx)
  await execP
  const ok: string = await t.pyrepl_init.execute({ bin_path: "/usr/bin/python3" }, ctx)
  expect(ok).toMatch(/REPL (ready|already running)/)
}, 60000)

test("no mem warn on small tasks", async () => {
  const r: string = await t.pyrepl_exec.execute({ code: "1 + 1" }, fakeCtx("tools-sess-nowarn"))
  expect(r).not.toContain("[warn:")
})

// NOTE: tools are invoked directly, bypassing opencode's zod transport
// validation, so NaN reaches the implementation. These tests pin the
// implementation-side fallbacks, not transport behavior.
test("NaN timeout_s falls back to default instead of throwing", async () => {
  const r: string = await t.pyrepl_exec.execute({ code: "40 + 2", timeout_s: NaN }, fakeCtx("tools-sess-nan"))
  expect(r).toContain("Out[1]: 42")
})

test("NaN limit falls back to default history size", async () => {
  const ctx = fakeCtx("tools-sess-nanlimit")
  await t.pyrepl_exec.execute({ code: "9" }, ctx)
  const st: string = await t.pyrepl_tasks.execute({ limit: NaN }, ctx)
  expect(st).toContain("recent (last 1):")
})

test("interrupt wait_s: NaN clamps to default", async () => {
  const ctx = fakeCtx("tools-sess-nanwait")
  const r: string = await t.pyrepl_exec.execute(
    { code: "while True:\n    pass", timeout_s: 1, on_timeout: "detach" }, ctx)
  const m = r.match(/task (t_\d+)/)
  expect(m).not.toBeNull()
  const ri: string = await t.pyrepl_interrupt.execute({ task_id: m![1], wait_s: NaN }, ctx)
  expect(ri).toContain("interrupted")
}, 15000)
