import { spawnSync } from "node:child_process"
import { readFileSync as rf, writeFileSync, existsSync } from "node:fs"
import plugin from "../index.js"

const MYPID = process.pid

if (process.platform !== "darwin" && process.platform !== "linux") {
  console.log(`skip: no CLI sleep inhibitor on ${process.platform}`)
  process.exit(0)
}
if (process.platform === "darwin" && !existsSync("/usr/bin/caffeinate")) {
  console.log("skip: /usr/bin/caffeinate not found")
  process.exit(0)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeStream() {
  const pending = []
  let waiter = null
  return {
    emit(e) {
      if (waiter) { const w = waiter; waiter = null; w({ value: e, done: false }) }
      else pending.push(e)
    },
    end() { if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }) } },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (pending.length) return Promise.resolve({ value: pending.shift(), done: false })
            return new Promise((res) => { waiter = res })
          },
          return() {
            if (waiter) { const w = waiter; waiter = null; w({ value: undefined, done: true }) }
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    },
  }
}

/** Count the inhibitor processes this test process is responsible for. */
function inhibitors() {
  if (process.platform === "linux") {
    const out = spawnSync("pgrep", ["-f", "opencode stay-awake"], { encoding: "utf8" }).stdout.trim()
    return out ? out.split("\n").filter(Boolean) : []
  }
  const out = spawnSync("pgrep", ["-x", "caffeinate"], { encoding: "utf8" }).stdout.trim()
  if (!out) return []
  return out.split("\n").filter(Boolean).filter((pid) => {
    const args = spawnSync("ps", ["-p", pid, "-o", "args="], { encoding: "utf8" }).stdout.trim()
    return args.includes(`-w ${MYPID}`)
  })
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`)
}

async function waitFor(fn, timeout, what) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeout) {
    if (fn()) return true
    await sleep(25)
  }
  throw new Error(`timeout waiting for ${what}`)
}

function freshCtx(overrides = {}) {
  const stream = makeStream()
  const ctx = {
    options: { graceMs: 400, quietMs: 1200, staleMs: 3000, sweepMs: 150, debug: false, ...overrides },
    event: { subscribe: () => stream.iterable },
  }
  return { ctx, stream }
}

/** Fully isolate each scenario: kill leftovers and drop shared module state. */
function resetShared() {
  for (const pid of inhibitors()) {
    try { process.kill(Number(pid), "SIGKILL") } catch {}
  }
  const shared = globalThis[Symbol.for("opencode.stay-awake")]
  if (shared) {
    if (shared.timer) clearTimeout(shared.timer)
    if (shared.sweeper) clearInterval(shared.sweeper)
  }
  delete globalThis[Symbol.for("opencode.stay-awake")]
}

async function scenario(name, fn) {
  console.log(`\n--- ${name} ---`)
  for (const f of ["/tmp/ka-work/t10.log", "/tmp/ka-work/t11.log", "/tmp/ka-work/t12.log"]) {
    try { writeFileSync(f, "") } catch {}
  }
  resetShared()
  const before = inhibitors().length
  try {
    await fn()
  } catch (err) {
    check(name + " (no exception)", false, String(err && err.message ? err.message : err))
  } finally {
    resetShared()
  }
  const after = inhibitors().length
  if (after !== before) check(`${name}: no leaked inhibitor`, false, `before=${before} after=${after}`)
}

await scenario("T1 basic lifecycle", async () => {
  const { ctx, stream } = freshCtx()
  const dispose = plugin.setup(ctx)
  await sleep(50)
  check("T1 no inhibitor at rest", inhibitors().length === 0)
  stream.emit({ type: "session.execution.started", data: { sessionID: "s1" } })
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  check("T1 inhibitor acquired on start", true)
  stream.emit({ type: "session.execution.succeeded", data: { sessionID: "s1" } })
  await sleep(150)
  check("T1 still held inside quiet window", inhibitors().length === 1)
  await waitFor(() => inhibitors().length === 0, 5000, "inhibitor release")
  check("T1 released after quiet+grace", true)
  dispose()
})

await scenario("T2 long silent tool call", async () => {
  const { ctx, stream } = freshCtx()
  const dispose = plugin.setup(ctx)
  await sleep(50)
  stream.emit({ type: "session.tool.called", data: { sessionID: "s2" } })
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  await sleep(2500) // far beyond quietMs, tool still running
  check("T2 held across long silent tool call", inhibitors().length === 1, "open work item keeps it alive")
  stream.emit({ type: "session.tool.success", data: { sessionID: "s2" } })
  await waitFor(() => inhibitors().length === 0, 5000, "release")
  check("T2 released once tool finished", true)
  dispose()
})

await scenario("T3 lost end event (stale cap)", async () => {
  const { ctx, stream } = freshCtx()
  const dispose = plugin.setup(ctx)
  await sleep(50)
  stream.emit({ type: "session.step.started", data: { sessionID: "s3" } })
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  await waitFor(() => inhibitors().length === 0, 8000, "stale release")
  check("T3 released by staleMs despite lost end event", true)
  dispose()
})

await scenario("T4 session.idle drops the session", async () => {
  const { ctx, stream } = freshCtx({ graceMs: 300 })
  const dispose = plugin.setup(ctx)
  await sleep(50)
  stream.emit({ type: "session.execution.started", data: { sessionID: "s4" } })
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  // A second session keeps the inhibitor alive; only s4 is dropped.
  stream.emit({ type: "session.execution.started", data: { sessionID: "s4b" } })
  stream.emit({ type: "session.idle", data: { sessionID: "s4" } })
  await sleep(700)
  check("T4 held while another session still works", inhibitors().length === 1)
  stream.emit({ type: "session.idle", data: { sessionID: "s4b" } })
  await waitFor(() => inhibitors().length === 0, 3000, "release")
  check("T4 released after both sessions idle", true)
  dispose()
})

await scenario("T5 two concurrent sessions", async () => {
  const { ctx, stream } = freshCtx()
  const dispose = plugin.setup(ctx)
  await sleep(50)
  stream.emit({ type: "session.execution.started", data: { sessionID: "a" } })
  stream.emit({ type: "session.execution.started", data: { sessionID: "b" } })
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  stream.emit({ type: "session.execution.succeeded", data: { sessionID: "a" } })
  await sleep(600)
  check("T5 held while second session still runs", inhibitors().length === 1)
  stream.emit({ type: "session.execution.succeeded", data: { sessionID: "b" } })
  await waitFor(() => inhibitors().length === 0, 5000, "release")
  check("T5 released when both finished", true)
  dispose()
})

await scenario("T6 blind stream holds", async () => {
  const { ctx, stream } = freshCtx()
  const dispose = plugin.setup(ctx)
  await sleep(50)
  stream.emit({ type: "session.execution.started", data: { sessionID: "s6" } })
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  stream.end()
  await sleep(600)
  check("T6 held while event stream is down", inhibitors().length === 1)
  // Past quietMs the idle sweep must not guess the session away while blind.
  await sleep(1600)
  check("T6 still held past quietMs while blind", inhibitors().length === 1)
  dispose()
  await waitFor(() => inhibitors().length === 0, 3000, "teardown release")
  check("T6 teardown releases", true)
})

await scenario("T10 tracked set self-cleans", async () => {
  const { ctx, stream } = freshCtx({ debug: true, debugFile: "/tmp/ka-work/t10.log" })
  const dispose = plugin.setup(ctx)
  await sleep(50)
  stream.emit({ type: "session.execution.started", data: { sessionID: "s10" } })
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  stream.emit({ type: "session.execution.succeeded", data: { sessionID: "s10" } })
  await waitFor(() => inhibitors().length === 0, 6000, "release")
  await sleep(700)
  const log = rf("/tmp/ka-work/t10.log", "utf8")
  check("T10 idle session dropped from tracking", /idle-drop sid=s10/.test(log), "map self-cleans")
  check("T10 inhibitor released", inhibitors().length === 0)
  dispose()
})

await scenario("T7 disabled by env", async () => {
  process.env.OPENCODE_STAY_AWAKE = "0"
  const { ctx, stream } = freshCtx()
  const dispose = plugin.setup(ctx)
  await sleep(50)
  stream.emit({ type: "session.execution.started", data: { sessionID: "s7" } })
  await sleep(400)
  check("T7 env kill switch prevents inhibitor", inhibitors().length === 0)
  delete process.env.OPENCODE_STAY_AWAKE
  dispose()
})

await scenario("T8 invalid options fall back to defaults", async () => {
  const { ctx, stream } = freshCtx({ graceMs: "nope", quietMs: -5, staleMs: null, flags: [], what: "  " })
  const dispose = plugin.setup(ctx)
  await sleep(50)
  stream.emit({ type: "session.execution.started", data: { sessionID: "s8" } })
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  stream.emit({ type: "session.execution.succeeded", data: { sessionID: "s8" } })
  await waitFor(() => inhibitors().length === 0, 20000, "release with default grace/quiet")
  check("T8 default timings applied to bad options", true)
  dispose()
})

await scenario("T9 double setup shares one inhibitor", async () => {
  const a = freshCtx()
  const b = freshCtx()
  const d1 = plugin.setup(a.ctx)
  const d2 = plugin.setup(b.ctx)
  await sleep(50)
  a.stream.emit({ type: "session.execution.started", data: { sessionID: "s9" } })
  await waitFor(() => inhibitors().length === 1, 2000, "single inhibitor")
  b.stream.emit({ type: "session.execution.succeeded", data: { sessionID: "s9" } })
  await waitFor(() => inhibitors().length === 0, 5000, "release")
  check("T9 one inhibitor across instances", true)
  d1(); d2()
})

await scenario("T11 event id dedupe across instances", async () => {
  const a = freshCtx({ debug: true, debugFile: "/tmp/ka-work/t11.log" })
  const b = freshCtx({ debug: true, debugFile: "/tmp/ka-work/t11.log" })
  const d1 = plugin.setup(a.ctx)
  const d2 = plugin.setup(b.ctx)
  await sleep(50)
  // The same logical event reaches both instances with the same id.
  const started = { id: "evt_1", type: "session.execution.started", data: { sessionID: "s11" } }
  const succeeded = { id: "evt_2", type: "session.execution.succeeded", data: { sessionID: "s11" } }
  a.stream.emit(started)
  b.stream.emit(started)
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  a.stream.emit(succeeded)
  b.stream.emit(succeeded)
  await waitFor(() => inhibitors().length === 0, 6000, "release")
  const log = rf("/tmp/ka-work/t11.log", "utf8")
  const openLines = log.split("\n").filter((l) => l.includes("type=session.execution.started"))
  check("T11 execution counted once despite two instances", openLines.length === 1 && /open=1\b/.test(openLines[0]), `lines=${openLines.length}`)
  check("T11 released after deduped close", inhibitors().length === 0)
  d1(); d2()
})

await scenario("T12 teardown stops the event loop", async () => {
  const { ctx, stream } = freshCtx({ debug: true, debugFile: "/tmp/ka-work/t12.log" })
  const dispose = plugin.setup(ctx)
  await sleep(50)
  stream.emit({ type: "session.execution.started", data: { sessionID: "s12" } })
  await waitFor(() => inhibitors().length === 1, 2000, "inhibitor start")
  dispose()
  await waitFor(() => rf("/tmp/ka-work/t12.log", "utf8").includes("run-stopped"), 3000, "loop stop")
  check("T12 run loop stopped after teardown", true)
  // Events emitted after teardown must be ignored (no resubscription).
  const before = rf("/tmp/ka-work/t12.log", "utf8").length
  stream.emit({ type: "session.execution.started", data: { sessionID: "s12b" } })
  await sleep(600)
  const after = rf("/tmp/ka-work/t12.log", "utf8").length
  check("T12 no events processed after teardown", after === before, `before=${before} after=${after}`)
  check("T12 inhibitor still released", inhibitors().length === 0)
})

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length) { console.log("FAILED:", failed.map((f) => f.name).join(", ")); process.exit(1) }
process.exit(0)
