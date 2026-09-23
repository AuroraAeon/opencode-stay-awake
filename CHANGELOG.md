# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-09-23

### Changed

- The npm description now names "system sleep" explicitly. It previously only
  said "keeps your computer awake", so the word "sleep" appeared nowhere in the
  package metadata and the package was invisible to `npm search opencode sleep`
  — the most obvious query a user with this problem would type.

### Fixed

- CI actions (`actions/checkout`, `actions/setup-node`) are pinned to commit
  SHAs instead of floating major tags, and `.github/dependabot.yml` keeps those
  pins current while ignoring major bumps.
- Added `package-lock.json` and `.github/SECURITY.md` with private
  vulnerability reporting.

## [1.0.1] - 2026-09-23

### Fixed

- The README's license badge was a dynamic shields.io npm badge that renders
  "package not found" when the registry metadata is cold or is served from a
  cache written before publication. Replaced with a static MIT badge, and the
  version badge now uses the `/latest` variant, so neither can report a missing
  package.

### Documentation

- Restructured the README around time-to-first-success, so install, verify and
  disable/remove all sit above the fold instead of several screens down.
- Added a contents list, an ASCII state diagram for the busy model, a
  "why not just use…" comparison against manual `caffeinate` / `pmset` /
  always-on toggles, an FAQ, and a symptom-to-cause troubleshooting table.
- Documented that `opencode plugin add` writes the config key as `"plugins"`
  (plural) while the examples use `"plugin"` — both are accepted and behave
  identically, so nobody mistakes their own config for a mistake.
- Design notes now record the v2 plugin contract, the event envelope, why
  event consumers must de-duplicate by event id, and the Bun `appendFile`
  gotcha, as reference findings beyond this plugin.

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
