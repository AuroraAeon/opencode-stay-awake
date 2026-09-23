# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-09-23

First release.

### Added

- Holds a system sleep inhibitor while any OpenCode v2 session is generating,
  and releases it once every session goes idle.
  - macOS: `caffeinate -dims -w <server pid>`
  - Linux: `systemd-inhibit --what=sleep:idle`, bound to the server pid
  - Other platforms: inert no-op
- Per-session **open work item** counting from paired session events
  (execution / step / tool / text / reasoning / compaction / shell), so long
  silent tool calls keep the inhibitor instead of being released mid-run.
- Quiet period, grace period and a stale cap, so the inhibitor is always
  released and can never be held forever by a lost end event.
- Event de-duplication by event id, because one server process hosts several
  plugin instances that each receive every event.
- Inhibitor lifetime bound to the OpenCode server pid, so a crashed or killed
  server can never wedge the machine awake.
- Opt-in debug trace (`debug` / `OPENCODE_STAY_AWAKE_DEBUG`) and a kill switch
  (`OPENCODE_STAY_AWAKE=0`).
- 24-check behavioural test suite (`npm test`) that drives the plugin with a
  fake event stream and asserts the real inhibitor lifecycle.

### Notable design decisions

- `session.get()` is deliberately **not** consulted: on v2 its `outcome` and
  `time.idle` are only written when an execution settles, so an actively
  generating session still reports the previous run's outcome.
- The plugin never throws during `setup()`; any unexpected error degrades to a
  no-op so a failure can never silently disable sleep protection.
