/** Options for the opencode-stay-awake plugin. */
export interface StayAwakeOptions {
  /**
   * Master switch for the plugin. Also honours `OPENCODE_STAY_AWAKE=0`
   * (or `false`/`off`/`no`) in the environment of the process that hosts
   * the OpenCode server.
   * @default true
   */
  enabled?: boolean
  /**
   * How long (ms) to keep holding the inhibitor after the last session goes
   * idle. Any new activity during this window cancels the release.
   * @default 3000
   */
  graceMs?: number
  /**
   * How long (ms) a tracked session with no open work item stays busy after
   * its last event. Covers the gap between an execution ending and the next
   * one starting, plus stream hiccups.
   * @default 10000
   */
  quietMs?: number
  /**
   * Drop sessions that emitted no events for this long (ms), and clear a work
   * item that has shown no progress for this long. Together these bound a work
   * item whose end event was lost (a dropped event stream, a plugin reload
   * mid-execution), which would otherwise hold the inhibitor for as long as
   * the session stays alive. `0` disables the cap.
   * @default 900000
   */
  staleMs?: number
  /**
   * How long (ms) to keep holding while no plugin instance has a live event
   * stream. With no stream nothing can arrive, so the only reason to hold is
   * to bridge a reconnect — and the stream retry backoff caps at 30s. Without
   * this bound, a plugin whose stream died for good would hold the machine
   * awake for `staleMs` with no evidence of any work at all.
   * @default 30000
   */
  blindMs?: number
  /**
   * How often (ms) to reconcile the tracked sessions and release the
   * inhibitor once everything is idle.
   * @default 5000
   */
  sweepMs?: number
  /**
   * Flags passed to `caffeinate` on macOS.
   * `-d` display, `-i` idle, `-m` disk, `-s` system (AC power only).
   * @default ["-dims"]
   */
  flags?: string[]
  /**
   * Value passed to `systemd-inhibit --what` on Linux.
   * @default "sleep:idle"
   */
  what?: string
  /**
   * Append a debug trace of every state transition to `debugFile`. Also
   * honours `OPENCODE_STAY_AWAKE_DEBUG=1`. Off by default.
   * @default false
   */
  debug?: boolean
  /**
   * Where the debug trace is written. Also honours
   * `OPENCODE_STAY_AWAKE_DEBUG_FILE`. Defaults to
   * `<tmpdir>/opencode-stay-awake.log`.
   */
  debugFile?: string
}

/** A server event as delivered to plugin subscriptions. */
export interface StayAwakeEvent {
  readonly id?: string
  readonly created?: number
  readonly type: string
  readonly location?: unknown
  readonly data?: { readonly sessionID?: string; [key: string]: unknown }
  /** Older servers may still use `properties` instead of `data`. */
  readonly properties?: { readonly sessionID?: string; [key: string]: unknown }
}

/** Minimal shape of the v2 plugin context this plugin relies on. */
export interface StayAwakeContext {
  readonly options?: StayAwakeOptions
  readonly event: {
    subscribe(): AsyncIterable<StayAwakeEvent>
  }
}

/** OpenCode v2 plugin definition. */
export interface StayAwakePlugin {
  readonly id: string
  readonly setup: (context: StayAwakeContext) => (() => void) | void
}

declare const plugin: StayAwakePlugin
export default plugin
