# opencode-stay-awake

[![npm version](https://img.shields.io/npm/v/opencode-stay-awake/latest.svg)](https://www.npmjs.com/package/opencode-stay-awake)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![CI](https://github.com/AuroraAeon/opencode-stay-awake/actions/workflows/ci.yml/badge.svg)](https://github.com/AuroraAeon/opencode-stay-awake/actions/workflows/ci.yml)

Keep your computer awake **while OpenCode is actually working** — and let it sleep
again the moment the work is done.

Long agent runs (model streaming, tool execution, compaction, rate-limit retries)
routinely take minutes with no user input. Default OS power settings treat that as
idle and suspend mid-prompt, so a run gets cut short halfway through. This plugin
holds a system sleep inhibitor for exactly the duration of the work, then releases
it.

- **macOS** — `caffeinate -dims -w <server pid>`
- **Linux** — `systemd-inhibit --what=sleep:idle`, bound to the server pid
- **Windows / others** — inert no-op

Zero dependencies, no network access, no telemetry. Requires OpenCode **v2**
(2.0.x), including the desktop app.

**Contents**

- [Install](#install)
- [Verify it works](#verify-it-works)
- [How it decides "busy"](#how-it-decides-busy)
- [Options](#options)
- [Environment variables](#environment-variables)
- [Platform notes](#platform-notes)
- [Why not just use…](#why-not-just-use)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Design notes](#design-notes)
- [License](#license)

---

## Install

```bash
opencode plugin add opencode-stay-awake
```

Then **restart the app** (or run `opencode reload`) so the running server picks it
up. Verify with the [check below](#verify-it-works).

Or add it to `opencode.json` yourself:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-stay-awake"]
}
```

With options — note the array form, the second element is the options object:

```json
{
  "plugin": [["opencode-stay-awake", { "graceMs": 5000 }]]
}
```

> **On the config key.** `opencode plugin add` writes the setting as `"plugins"`
> (plural). Both `"plugin"` and `"plugins"` are accepted and behave identically,
> so don't worry if your file doesn't match the examples here.
>
> Options are only delivered from the **global** config
> (`~/.config/opencode/opencode.json`). A project-level `opencode.json` can load
> the plugin, but its options are not passed through — use the global file if you
> need to tune anything.

### From a local file

Drop a copy of `index.js` into the global plugin directory. Files there are picked
up automatically and hot-reload when edited:

```bash
mkdir -p ~/.config/opencode/plugins
curl -fsSL https://unpkg.com/opencode-stay-awake/index.js > ~/.config/opencode/plugins/stay-awake.js
```

A local file takes no options — use the npm form if you need to configure it.

> `opencode plugin add` only accepts npm registry or Git package specifiers, so a
> local `.tgz` cannot be installed that way. A `file:` specifier in
> `opencode.json` also works, but it makes the server log a harmless
> `failed to check plugin update` warning on every start.

### Disable or remove

| Situation | What to do |
| --- | --- |
| Temporarily off | Set `OPENCODE_STAY_AWAKE=0` in the environment of the process that hosts the server |
| One run off | `OPENCODE_STAY_AWAKE=0 opencode run --standalone …` |
| Installed via npm | `opencode plugin remove opencode-stay-awake` |
| Installed as a file | Delete `~/.config/opencode/plugins/stay-awake.js` |
| Added by hand | Remove the entry from `opencode.json` |

## Verify it works

Start any session and check that exactly one inhibitor is held while it runs:

```bash
pgrep -fl caffeinate        # macOS
systemd-inhibit --list      # Linux
```

Expected output looks like `caffeinate -dims -w <pid>` — the `-w <pid>` is the
OpenCode server, and it is what guarantees the inhibitor dies with the server.

To see the plugin's own decisions, turn on the debug trace:

```json
{ "plugin": [["opencode-stay-awake", { "debug": true }]] }
```

```bash
tail -f "${TMPDIR}opencode-stay-awake.log"
```

A healthy trace for one run:

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

The number after `open=` should climb to a handful and return to `0`.

## How it decides "busy"

The plugin subscribes to the server event stream and keeps a counter of **open
work items** per session, built from events that arrive in reliable pairs:

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

```
  session event ──► track the session, refresh liveness
                             │
                open work items > 0 ?
                  │                │
                 yes               no
                  │                │
                  ▼                ▼
           ┌────────────────────────────────┐
           │  BUSY — hold the inhibitor     │◄── quiet for less than quietMs
           └────────────────┬───────────────┘
                            │ both conditions false
                            ▼
           ┌────────────────────────────────┐
           │ IDLE — wait graceMs, then      │
           │ release the inhibitor          │
           └────────────────────────────────┘

  no events at all for staleMs  ──►  forget the session entirely
```

Three further rules keep it honest:

- **Quiet period** — any event refreshes a session's liveness, and a session with
  no open work item stops counting as busy after `quietMs` of silence.
- **Grace period** — once no session is busy, the inhibitor is released `graceMs`
  later, so back-to-back executions never flap.
- **Stale cap** — a session that emits nothing at all for `staleMs` is dropped.
  This bounds the damage of an end event lost to a dropped stream or a plugin
  reload, which would otherwise hold the inhibitor forever.

Every inhibitor is bound to the OpenCode **server pid**, so a crashed, killed or
reloaded server releases it on its own — the machine can never be wedged awake.

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

Invalid values fall back to the defaults rather than throwing, so a typo in the
config can never stop the plugin from loading.

## Environment variables

Read in the **server** process (see the caveat below):

| Variable | Effect |
| --- | --- |
| `OPENCODE_STAY_AWAKE=0` | Disable the plugin (also `false`, `off`, `no`). |
| `OPENCODE_STAY_AWAKE_DEBUG=1` | Enable the debug trace. |
| `OPENCODE_STAY_AWAKE_DEBUG_FILE=<path>` | Redirect the debug trace. |

> **Where the environment variable applies.** The plugin runs inside the OpenCode
> *server* process, not the CLI that starts a run. Against the desktop app's
> shared server, `OPENCODE_STAY_AWAKE=0 opencode run …` therefore has no effect —
> the variable must be present where the server itself was launched. It does work
> per-run with a private server, because that inherits the client's environment:
> `OPENCODE_STAY_AWAKE=0 opencode run --standalone …`.

## Platform notes

**macOS** — uses `/usr/bin/caffeinate`. The default `-dims` covers display
(`-d`), idle (`-i`), disk (`-m`) and system-on-AC (`-s`). This is the
best-supported path.

**Linux** — uses `systemd-inhibit` from systemd/logind. The plugin also requires
`/run/systemd/system` to exist, so on a non-systemd box it stays inert rather than
failing. The lock is held by a wrapper that polls the server pid, so it is
released even if the server is `SIGKILL`ed.

**Windows** — not supported. There is no command-line sleep inhibitor that can be
bound to another process's lifetime; a native `SetThreadExecutionState` helper
would be needed. The plugin loads and does nothing.

## Why not just use…

| Approach | Behaviour |
| --- | --- |
| `caffeinate -dims` by hand | Never releases. You have to remember to kill it, and forgetfulness leaves the machine awake until you notice. |
| Energy Saver / `pmset` | A global OS setting. Always on, unrelated to whether work is happening. |
| Amphetamine, KeepingYouAwake, … | Manual toggle. On until you turn it off, whether or not anything is running. |
| A "keep awake" setting in the desktop app | Desktop-only and manual. Typically stays on until the app quits, including across idle stretches where nothing is running. |
| **This plugin** | Automatic. Holds only while a session is generating, releases as soon as it finishes, and covers the CLI as well as the desktop app. |

## FAQ

**Does it stop my display from sleeping?**
With the default `-dims` flags, yes — that is what the `-d` does. If you only
want to stop *idle* sleep and let the display turn off normally, set
`"flags": ["-i"]`.

**Does it need network access or send anything anywhere?**
No. Zero dependencies, and the only process it ever spawns is `caffeinate` or
`systemd-inhibit` on your own machine.

**What happens if the plugin crashes, or OpenCode is killed?**
The inhibitor is bound to the server pid, so it disappears with the server. A
crashed plugin cannot wedge the machine awake.

**Will it hold the inhibitor forever if an end event is lost?**
No. A session that emits nothing at all for `staleMs` (15 minutes by default) is
dropped, which bounds the hold. Set `staleMs` lower to tighten it, or `0` to
disable the cap.

**Does it work with `opencode run` and the TUI, or only the desktop app?**
Both. It is a server plugin, so it applies wherever the server runs.

**Can I run it without installing anything?**
Yes — copy `index.js` into `~/.config/opencode/plugins/` as described
[above](#from-a-local-file).

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| No `caffeinate` while a session runs | Check the [debug trace](#verify-it-works). `inactive reason=no-inhibitor` means the platform is unsupported or the env kill switch is on; `reason=no-event-api` means the server is older than v2. |
| `open=` climbs without bound | The server is running more than one copy of the plugin. Restart the app, or run `opencode reload`. |
| Inhibitor released in the middle of a long tool call | Raise `quietMs`. A tool call that produces no events for longer than `quietMs` after its work item closed will be treated as idle. |
| Inhibitor held long after work finishes | Usually a lost end event; the `staleMs` cap will clear it. Lower `staleMs` if it bothers you. |
| Nothing happens at all | Make sure you restarted the app after installing, and that the entry is in the **global** config if you need options. |

> **After installing or upgrading, restart the app** (or run `opencode reload`).
> Files in `~/.config/opencode/plugins/` hot-reload, but a long-lived server that
> has been running across an upgrade can keep an instance of the previous version
> subscribed alongside the new one. Because every instance receives every event,
> that inflates the shared work counters. A restart clears it; the `staleMs` cap
> bounds the effect in the meantime, so the worst case is an inhibitor held a
> little too long, never a wedged machine.

## Development

```bash
npm test        # 24 behavioural checks against a synthetic event stream
npm run check   # syntax check only
```

CI runs the same suite on `macos-latest` on every push and pull request.

The test suite drives the plugin with a fake event stream and asserts the real
inhibitor lifecycle: spawn, hold across long tool calls, release on idle, release
after a lost end event, hold while the event stream is down, de-duplication
across instances, and teardown. It needs `caffeinate` on macOS or
`systemd-inhibit` on Linux and exits non-zero on failure. Trace files go into a
private temporary directory, so the suite is hermetic and safe to run anywhere.

## Design notes

Findings from building against OpenCode v2 (2.0.x), recorded here in case they are
useful beyond this plugin:

- **Plugin contract.** The module must `export default { id, setup }`. The
  named-export form still shown in the official plugin docs
  (`export const MyPlugin = async (ctx) => ({ … })`) fails to load on 2.0.x with
  *"Plugin must export a default definition with an id and an effect or setup
  function"*. `setup` may return a cleanup function, which is called on reload.
- **Event envelope.** Events arrive as `{id, created, type, location, data}` with
  the payload under `event.data`, not `.properties`. Every event carries a unique
  `id` that is identical across subscribers.
- **Several instances per server.** One server process hosts one instance of a
  plugin per workspace, and every instance receives every event. Any shared
  counter therefore needs de-duplication by event id, or it moves once per
  instance instead of once per event. This is why the plugin keeps a `seen` map
  keyed on `event.id`.
- **`session.get()` is unreliable for liveness.** On v2 its `outcome` and
  `time.idle` are only written when an execution settles, so a session that is
  actively generating still reports the *previous* run's `succeeded` outcome.
  Trusting it would drop running sessions mid-flight. The event stream is the
  only reliable source of truth.
- **No logging API is reachable** from the v2 plugin context (there is no
  `client`), which is why the debug trace goes to a file instead of
  `client.app.log()`.
- **Bun runtime gotcha.** `appendFile` from `node:fs` without a callback throws
  `ERR_INVALID_ARG_TYPE` under Bun, which would take the whole plugin down during
  setup. The plugin uses `appendFileSync` and never throws out of `setup()` — an
  unexpected error degrades to a no-op so a failure can never silently disable
  sleep protection.

## License

MIT — see [LICENSE](./LICENSE).

Security reports: [.github/SECURITY.md](./.github/SECURITY.md).
