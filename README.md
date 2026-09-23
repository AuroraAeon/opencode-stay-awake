# opencode-stay-awake

[![npm version](https://img.shields.io/npm/v/opencode-stay-awake.svg)](https://www.npmjs.com/package/opencode-stay-awake)
[![license](https://img.shields.io/npm/l/opencode-stay-awake.svg)](./LICENSE)

OpenCode **v2** server plugin that keeps your computer awake **while OpenCode is
actually working** — and lets it sleep again the moment every session goes idle.

Long agent runs (model streaming, tool execution, compaction, rate-limit
retries) routinely take minutes with no user input. Default OS power settings
treat that as idle and suspend mid-prompt. This plugin holds a system sleep
inhibitor for exactly the duration of the work, then releases it.

- **macOS** — `caffeinate -dims -w <server pid>`
- **Linux** — `systemd-inhibit --what=sleep:idle` (logind), bound to the server pid
- **Windows / others** — inert no-op (no reliable CLI inhibitor exists)

Zero dependencies. Requires OpenCode **v2** (2.0.x), including the desktop app.

## Install

### From npm (recommended)

```bash
opencode plugin add opencode-stay-awake
```

or add it to `opencode.json` yourself:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-stay-awake"]
}
```

With options (note the array form — the second element is the options object):

```json
{
  "plugin": [["opencode-stay-awake", { "graceMs": 5000 }]]
}
```

### From a local file

Drop a copy of `index.js` into the global plugin directory. Files there are
picked up automatically and hot-reload when edited:

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://unpkg.com/opencode-stay-awake/index.js > ~/.config/opencode/plugins/stay-awake.js
```

A local file takes no options — use the npm form if you need to configure it.

> `opencode plugin add` only accepts npm registry or Git package specifiers, so
> a local `.tgz` cannot be installed that way. A `file:` specifier in
> `opencode.json` also works, but it makes the server log a harmless
> `failed to check plugin update` warning on every start.

## How it decides "busy"

The plugin subscribes to the server event stream and tracks a counter of **open
work items** per session, from events that come in reliable pairs:

| opens a work item | closes it |
| --- | --- |
| `session.execution.started` | `session.execution.succeeded` / `.failed` / `.interrupted` |
| `session.step.started` | `session.step.ended` / `.failed` |
| `session.tool.called`, `session.tool.input.started` | `session.tool.success` / `.failed`, `session.tool.input.ended` |
| `session.text.started` | `session.text.ended` |
| `session.reasoning.started` | `session.reasoning.ended` |
| `session.compaction.started` | `session.compaction.ended` / `.failed` |
| `session.shell.started` | `session.shell.ended` |

A session is **busy** while it has any open work item. Because a tool call that
runs for minutes (a build, a test suite) keeps its work item open, the inhibitor
survives long silences instead of being released in the middle of them.

Three further rules keep it honest:

- **Quiet period** — any event refreshes a session's liveness, and a session
  with no open work item stops counting as busy after `quietMs` of silence.
- **Grace period** — once no session is busy, the inhibitor is released
  `graceMs` later, so back-to-back executions never flap.
- **Stale cap** — a session that emits nothing at all for `staleMs` is dropped.
  This bounds the damage of an end event that was lost to a dropped stream or a
  plugin reload, which would otherwise hold the inhibitor forever.

Every inhibitor is bound to the OpenCode **server pid**, so a crashed, killed or
reloaded server releases it on its own — the machine can never be wedged awake.

Two deliberate non-choices worth knowing about:

- **`session.get()` is not consulted.** On v2 its `outcome` and `time.idle`
  fields are only written when an execution settles, so a session that is
  actively generating still reports the *previous* run's `succeeded` outcome.
  Trusting it would drop running sessions mid-flight. The event stream is the
  only reliable source of truth.
- **Events are de-duplicated by id.** One server process usually hosts several
  instances of this plugin (one per workspace) and every instance receives
  every event, so without de-duplication the shared counters would move once
  per instance instead of once per event.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `graceMs` | `3000` | Hold the inhibitor this long after the last session goes idle. |
| `quietMs` | `10000` | A tracked session with no open work item goes idle after this much silence. |
| `staleMs` | `900000` | Drop sessions with no events at all for this long. `0` disables. |
| `sweepMs` | `5000` | How often to reconcile and release. |
| `flags` | `["-dims"]` | `caffeinate` flags on macOS. Use `["-i"]` to inhibit idle sleep only and leave the display alone. |
| `what` | `"sleep:idle"` | `systemd-inhibit --what` value on Linux. |
| `debug` | `false` | Write a debug trace to `debugFile`. |
| `debugFile` | `<tmpdir>/opencode-stay-awake.log` | Debug trace location. |

Environment variables (read in the **server** process, see the caveat below):

| Variable | Effect |
| --- | --- |
| `OPENCODE_STAY_AWAKE=0` | Disable the plugin (also `false`, `off`, `no`). |
| `OPENCODE_STAY_AWAKE_DEBUG=1` | Enable the debug trace. |
| `OPENCODE_STAY_AWAKE_DEBUG_FILE=<path>` | Redirect the debug trace. |

## Troubleshooting

Turn on the debug trace and watch it while a session runs:

```json
{ "plugin": [["opencode-stay-awake", { "debug": true }]] }
```

```bash
tail -f "${TMPDIR}opencode-stay-awake.log"
```

Typical healthy trace for one run:

```
ready sessions=0 inhibitor=0
track sid=ses_…
open sid=ses_… type=session.execution.started open=1
inhibitor-start cmd=caffeinate pid=12345
open sid=ses_… type=session.step.started open=2
…
close sid=ses_… type=session.execution.succeeded open=0
inhibitor-stop pid=12345
```

Check whether an inhibitor is actually held:

```bash
pgrep -fl caffeinate        # macOS
systemd-inhibit --list      # Linux
```

> **Where the environment variable applies.** The plugin runs inside the
> OpenCode *server* process, not the CLI that starts a run. Against the desktop
> app's shared server, `OPENCODE_STAY_AWAKE=0 opencode run …` therefore has no
> effect — the variable must be present where the server itself was launched.
> It does work per-run with a private server, because that inherits the
> client's environment: `OPENCODE_STAY_AWAKE=0 opencode run --standalone …`.

## Development

```bash
npm test        # 24 behavioural checks against a synthetic event stream
node --check index.js
```

The test suite drives the plugin with a fake event stream and asserts the real
inhibitor lifecycle (spawn, hold across long tool calls, release on idle,
release after a lost end event, hold while the event stream is down,
de-duplication across instances, teardown). It needs `caffeinate` on macOS or
`systemd-inhibit` on Linux and exits non-zero on failure.

## Notes

- **v2 only.** The plugin uses the v2 plugin contract: the module must
  `export default { id, setup }`. The named-export form still shown in the
  official plugin docs (`export const MyPlugin = async (ctx) => ({ … })`) fails
  to load on 2.0.x with `Plugin must export a default definition with an id and
  an effect or setup function`.
- **Event payloads live under `event.data`** on 2.0.x; the older
  `event.properties` shape is still accepted as a fallback.
- **No logging API is reachable** from the v2 plugin context (there is no
  `client`), which is why the debug trace goes to a file instead of
  `client.app.log()`.
- **Windows is not supported.** There is no command-line sleep inhibitor that
  can be bound to another process's lifetime; a native `SetThreadExecutionState`
  helper would be needed.

## License

MIT
