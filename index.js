/**
 * opencode-stay-awake — OpenCode v2 server plugin
 *
 * Holds a system sleep inhibitor while any OpenCode session is generating, so
 * long agent runs (model streaming, tool execution, compaction, rate-limit
 * retries) are never cut short by an idle sleep — and releases it as soon as
 * the work is done.
 *
 *   macOS  caffeinate -dims -w <server pid>
 *   Linux  systemd-inhibit --what=sleep:idle, bound to the server pid
 *   other  no-op
 *
 * Every inhibitor is bound to the OpenCode server pid, so a crashed, killed or
 * reloaded server can never wedge the machine awake.
 *
 * Install:
 *   opencode plugin add opencode-stay-awake
 * or in opencode.json:
 *   { "plugin": [["opencode-stay-awake", { "graceMs": 5000 }]] }
 *
 * How "busy" is decided (deliberately event-driven, see README):
 *   - paired work events (step/tool/text/reasoning/compaction/execution/
 *     shell) open and close a per-session counter — a session is busy while
 *     any work item is open, which covers long silent tool calls;
 *   - any event for a tracked session refreshes its liveness, and a session
 *     with no open work item goes idle after `quietMs` of silence;
 *   - a session with no events at all for `staleMs` is dropped, so a lost end
 *     event can never hold the inhibitor forever.
 */

import { existsSync, appendFileSync } from "node:fs"
import { spawn } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PLUGIN_ID = "stay-awake"

/** Shared across every instance of this plugin inside one server process. */
const SHARED_KEY = Symbol.for("opencode.stay-awake")

/**
 * How many processed event ids to remember. One server process usually runs
 * several instances of this plugin (one per workspace) and every instance
 * receives every event, so without this the shared work counters would be
 * incremented once per instance instead of once per event.
 */
const SEEN_LIMIT = 4096

const DEFAULTS = {
  /** Master switch. Also honours OPENCODE_STAY_AWAKE=0/false/off/no. */
  enabled: true,
  /** How long to hold the inhibitor after the last session goes idle. */
  graceMs: 3000,
  /**
   * How long a tracked session with no open work item stays busy after its
   * last event. Covers the gap between an execution ending and the next one
   * starting, and stream hiccups.
   */
  quietMs: 10_000,
  /**
   * Drop sessions that emitted no events for this long. Guards against work
   * items whose end event was lost (dropped stream, plugin reload), which
   * would otherwise hold the inhibitor forever. 0 disables.
   */
  staleMs: 15 * 60_000,
  /** How often to reconcile busy sessions. */
  sweepMs: 5_000,
  /** caffeinate flags (macOS): -d display, -i idle, -m disk, -s system (AC). */
  flags: ["-dims"],
  /** systemd-inhibit --what value (Linux). */
  what: "sleep:idle",
  /** Append a debug trace to `debugFile`. Also honours OPENCODE_STAY_AWAKE_DEBUG. */
  debug: false,
  /** Debug trace location. Also honours OPENCODE_STAY_AWAKE_DEBUG_FILE. */
  debugFile: join(tmpdir(), "opencode-stay-awake.log"),
}

/**
 * Events that open a unit of work. Each one is paired with a close event, so
 * a counter per session tells us whether anything is genuinely in flight.
 */
const OPEN_EVENTS = new Set([
  "session.execution.started",
  "session.step.started",
  "session.tool.called",
  "session.tool.input.started",
  "session.text.started",
  "session.reasoning.started",
  "session.compaction.started",
  "session.shell.started",
])

/** Events that close a unit of work. */
const CLOSE_EVENTS = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.step.ended",
  "session.step.failed",
  "session.tool.success",
  "session.tool.failed",
  "session.tool.input.ended",
  "session.text.ended",
  "session.reasoning.ended",
  "session.compaction.ended",
  "session.compaction.failed",
  "session.shell.ended",
])

/** Events that mean the session is gone and can be forgotten immediately. */
const DROP_EVENTS = new Set(["session.idle", "session.deleted"])

const DISABLE_VALUES = new Set(["0", "false", "off", "no"])
const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"])

function isDisabledByEnv() {
  const raw = process.env.OPENCODE_STAY_AWAKE
  return typeof raw === "string" && DISABLE_VALUES.has(raw.trim().toLowerCase())
}

function findInPath(binary) {
  for (const dir of (process.env.PATH || "").split(":")) {
    if (!dir) continue
    const candidate = dir.endsWith("/") ? dir + binary : dir + "/" + binary
    try {
      if (existsSync(candidate)) return candidate
    } catch {
      // ignore unreadable PATH entries
    }
  }
  return undefined
}

/**
 * Resolve the platform inhibitor command, or null when this platform has no
 * usable inhibitor (the plugin then stays completely inert).
 *
 * Both inhibitors are bound to the OpenCode server pid, so they disappear on
 * their own if the server is killed: a crashed server cannot wedge the
 * machine awake.
 */
function createInhibitor(options) {
  if (process.platform === "darwin") {
    if (!existsSync("/usr/bin/caffeinate")) return null
    return {
      command: "caffeinate",
      args: () => [...options.flags, "-w", String(process.pid)],
    }
  }

  if (process.platform === "linux") {
    // logind is the only inhibitor source reachable from the CLI.
    if (!existsSync("/run/systemd/system")) return null
    const command = findInPath("systemd-inhibit")
    if (!command) return null
    return {
      command,
      // The wrapper polls the OpenCode server pid, so the lock is released
      // even if the server is SIGKILLed and this process never gets to run
      // its own cleanup.
      args: () => [
        `--what=${options.what}`,
        "--why=opencode stay-awake",
        "sh",
        "-c",
        `while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done`,
      ],
    }
  }

  return null
}

function normalizeOptions(raw) {
  const options = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) }
  options.enabled = options.enabled !== false
  for (const key of ["graceMs", "quietMs", "staleMs", "sweepMs"]) {
    options[key] =
      typeof options[key] === "number" && Number.isFinite(options[key]) && options[key] >= 0
        ? options[key]
        : DEFAULTS[key]
  }
  options.flags =
    Array.isArray(options.flags) && options.flags.length > 0 ? options.flags.map(String) : DEFAULTS.flags
  options.what = typeof options.what === "string" && options.what.trim() ? options.what.trim() : DEFAULTS.what
  options.debugFile =
    typeof options.debugFile === "string" && options.debugFile.trim()
      ? options.debugFile.trim()
      : DEFAULTS.debugFile
  options.debug =
    options.debug === true ||
    (typeof process.env.OPENCODE_STAY_AWAKE_DEBUG === "string" &&
      TRUTHY_VALUES.has(process.env.OPENCODE_STAY_AWAKE_DEBUG.trim().toLowerCase()))
  return options
}

/** Unref'd delay that never keeps a process alive on its own. */
function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer.unref === "function") timer.unref()
  })
}

/**
 * Debug trace writer. Never throws: a broken debug destination must not be
 * able to take the plugin (and with it the sleep protection) down. Uses the
 * sync API because the Bun runtime the server runs on does not return a
 * promise from `appendFile` without a callback.
 */
function createLogger(options) {
  if (!options.debug) return () => {}
  const file = process.env.OPENCODE_STAY_AWAKE_DEBUG_FILE || options.debugFile
  let broken = false
  return (event, extra) => {
    if (broken) return
    const line = `${new Date().toISOString()} pid=${process.pid} ${event}${
      extra ? " " + Object.entries(extra).map(([k, v]) => `${k}=${v}`).join(" ") : ""
    }\n`
    try {
      appendFileSync(file, line)
    } catch {
      broken = true
    }
  }
}

function getShared() {
  let shared = globalThis[SHARED_KEY]
  if (!shared) {
    shared = {
      proc: null,
      timer: null,
      sweeper: null,
      instances: 0,
      liveStreams: 0,
      sessions: new Map(),
      seen: new Map(),
    }
    globalThis[SHARED_KEY] = shared
  }
  // Normalise state left behind by an older version of this plugin.
  if (!(shared.sessions instanceof Map)) shared.sessions = new Map()
  if (typeof shared.liveStreams !== "number") shared.liveStreams = 0
  if (!(shared.seen instanceof Map)) shared.seen = new Map()
  return shared
}

function setupPlugin(context) {
    const options = normalizeOptions(context && context.options)
    const log = createLogger(options)

    const inhibitor = options.enabled && !isDisabledByEnv() ? createInhibitor(options) : null
    if (!inhibitor || !context || !context.event || typeof context.event.subscribe !== "function") {
      log("inactive", { platform: process.platform, reason: inhibitor ? "no-event-api" : "no-inhibitor" })
      return () => {}
    }

    // One server process can host several plugin instances (one per workspace
    // instance). Share state through the global registry so at most one
    // inhibitor process is ever spawned per server.
    const shared = getShared()
    shared.instances += 1

    const clearTimer = () => {
      if (shared.timer) {
        clearTimeout(shared.timer)
        shared.timer = null
      }
    }

    /** SIGTERM the inhibitor and its children (Linux wrapper `sh`). */
    const killInhibitor = (proc) => {
      try {
        proc.kill(-proc.pid, "SIGTERM")
      } catch {
        try {
          proc.kill("SIGTERM")
        } catch {
          // already gone
        }
      }
    }

    const start = () => {
      clearTimer()
      if (shared.proc) return
      let proc
      try {
        proc = spawn(inhibitor.command, inhibitor.args(), {
          detached: true,
          stdio: "ignore",
        })
      } catch (err) {
        log("spawn-error", { error: String(err && err.message ? err.message : err).slice(0, 200) })
        return
      }
      proc.unref()
      proc.on("error", () => {
        if (shared.proc === proc) shared.proc = null
      })
      proc.on("exit", () => {
        if (shared.proc === proc) shared.proc = null
      })
      shared.proc = proc
      log("inhibitor-start", { cmd: inhibitor.command, pid: proc.pid })
    }

    const stop = () => {
      clearTimer()
      const proc = shared.proc
      if (!proc) return
      shared.proc = null
      killInhibitor(proc)
      log("inhibitor-stop", { pid: proc.pid })
    }

    const isBusy = (now) => {
      // While no instance has a live event stream we are blind: a session may
      // be working without us seeing it, so hold rather than guess.
      if (shared.liveStreams === 0 && shared.sessions.size > 0) return true
      for (const entry of shared.sessions.values()) {
        if (entry.open > 0 || now - entry.seen < options.quietMs) return true
      }
      return false
    }

    const stopIfIdle = () => {
      if (shared.timer || isBusy(Date.now())) return
      const timer = setTimeout(stop, options.graceMs)
      if (typeof timer.unref === "function") timer.unref()
      shared.timer = timer
      log("grace", { ms: options.graceMs, sessions: shared.sessions.size })
    }

    /**
     * Forget sessions that are provably done, so the tracked set stays the
     * size of the live work rather than of all history:
     *   - idle: no open work item and quiet for longer than `quietMs`;
     *   - stale: no events at all for `staleMs`, which is also what bounds a
     *     work item whose end event was lost.
     * While no instance has a live event stream we are blind, so idle
     * sessions are kept (and the inhibitor held) instead of guessed away.
     */
    const sweep = () => {
      const now = Date.now()
      const blind = shared.liveStreams === 0
      for (const [sessionID, entry] of shared.sessions) {
        const age = now - entry.seen
        if (options.staleMs > 0 && age > options.staleMs) {
          shared.sessions.delete(sessionID)
          log("stale-drop", { sid: sessionID, open: entry.open, age })
        } else if (!blind && entry.open === 0 && age > options.quietMs) {
          shared.sessions.delete(sessionID)
          log("idle-drop", { sid: sessionID, age })
        }
      }
      if (shared.proc && !isBusy(now)) stopIfIdle()
      if (shared.sessions.size > 0 || shared.proc) {
        log("sweep", {
          sessions: shared.sessions.size,
          open: [...shared.sessions.values()].filter((e) => e.open > 0).length,
          inhibitor: shared.proc ? shared.proc.pid : 0,
        })
      }
    }

    const track = (sessionID) => {
      let entry = shared.sessions.get(sessionID)
      if (!entry) {
        entry = { seen: Date.now(), open: 0 }
        shared.sessions.set(sessionID, entry)
        log("track", { sid: sessionID })
      }
      return entry
    }

    /** Remember an event id, dropping the oldest once the window is full. */
    const markSeen = (id) => {
      shared.seen.set(id, 0)
      if (shared.seen.size > SEEN_LIMIT) {
        const keys = shared.seen.keys()
        for (let drop = shared.seen.size - SEEN_LIMIT; drop > 0; drop -= 1) {
          const oldest = keys.next().value
          if (oldest === undefined) break
          shared.seen.delete(oldest)
        }
      }
    }

    const handleEvent = (event) => {
      const type = event && event.type
      if (!type) return
      // Several plugin instances share one server process and each receives
      // every event; process each event exactly once.
      const eventID = event && event.id
      if (typeof eventID === "string" && eventID) {
        if (shared.seen.has(eventID)) return
        markSeen(eventID)
      }
      const data = (event && (event.data || event.properties)) || {}
      const sessionID = data.sessionID
      if (!sessionID) return

      if (DROP_EVENTS.has(type)) {
        if (shared.sessions.delete(sessionID)) log("drop", { sid: sessionID, type })
        stopIfIdle()
        return
      }

      const entry = track(sessionID)
      entry.seen = Date.now()

      if (OPEN_EVENTS.has(type)) {
        entry.open += 1
        log("open", { sid: sessionID, type, open: entry.open })
        start()
        return
      }

      if (CLOSE_EVENTS.has(type)) {
        if (entry.open > 0) entry.open -= 1
        log("close", { sid: sessionID, type, open: entry.open })
        stopIfIdle()
        return
      }

      // Any other event for a tracked session proves it is still alive, which
      // is what keeps long silences (a big build, a slow model) covered. It
      // can only make the session busier, so there is nothing to re-evaluate.
    }

    // Set by teardown. Without it a disposed instance would keep resubscribing
    // forever, and every reload would leave another loop consuming events.
    let stopped = false
    // The stream this instance is currently reading, so teardown can close it
    // and release a loop that is parked waiting for the next event.
    let activeIterator = null

    const run = async () => {
      let backoff = 1000
      while (!stopped) {
        shared.liveStreams += 1
        let iterator = null
        try {
          const iterable = context.event.subscribe()
          iterator =
            iterable && typeof iterable[Symbol.asyncIterator] === "function"
              ? iterable[Symbol.asyncIterator]()
              : null
          if (!iterator) throw new Error("event.subscribe() is not async iterable")
          activeIterator = iterator
          for (;;) {
            const next = await iterator.next()
            if (next.done) break
            backoff = 1000
            handleEvent(next.value)
          }
          log("stream-ended")
        } catch (err) {
          // The event stream failed (server shutdown or a dropped stream).
          // The inhibitor is pid-bound, so a dead server releases it anyway.
          log("stream-error", { error: String(err && err.message ? err.message : err).slice(0, 200) })
        } finally {
          shared.liveStreams = Math.max(0, shared.liveStreams - 1)
          if (activeIterator === iterator) activeIterator = null
          // Release a stream we are no longer reading, so the server does not
          // keep a subscriber (and its buffer) alive for a dead plugin.
          if (iterator && typeof iterator.return === "function") {
            void iterator.return().catch(() => {})
          }
        }
        if (stopped) break
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 30_000)
        sweep()
      }
      log("run-stopped")
    }

    // Pick up work already in flight (e.g. a plugin reload mid-session) and
    // start sweeping so orphaned executions cannot hold the inhibitor.
    if (!shared.sweeper) {
      shared.sweeper = setInterval(sweep, options.sweepMs)
      if (typeof shared.sweeper.unref === "function") shared.sweeper.unref()
    }
    if (isBusy(Date.now())) start()
    log("ready", { sessions: shared.sessions.size, inhibitor: shared.proc ? shared.proc.pid : 0 })

    void run()

    return () => {
      stopped = true
      // Unblock a loop parked in `await iterator.next()`.
      const iterator = activeIterator
      activeIterator = null
      if (iterator && typeof iterator.return === "function") void iterator.return().catch(() => {})
      shared.instances -= 1
      // Only tear the inhibitor down when the last instance goes away; the
      // pid binding already covers a dying server.
      if (shared.instances <= 0) {
        shared.instances = 0
        if (shared.sweeper) {
          clearInterval(shared.sweeper)
          shared.sweeper = null
        }
        stop()
        log("teardown")
      }
    }
}

export default {
  id: PLUGIN_ID,
  setup(context) {
    try {
      return setupPlugin(context)
    } catch (err) {
      // A plugin that throws during setup is dropped by the loader, which
      // would silently disable sleep protection. Degrade to a no-op instead
      // and leave a trace for debugging.
      try {
        appendFileSync(
          process.env.OPENCODE_STAY_AWAKE_DEBUG_FILE || DEFAULTS.debugFile,
          `${new Date().toISOString()} pid=${process.pid} setup-error ${String(
            err && err.stack ? err.stack : err,
          ).slice(0, 500)}\n`,
        )
      } catch {
        // nowhere to report to
      }
      return () => {}
    }
  },
}
