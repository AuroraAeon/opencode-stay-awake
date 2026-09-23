# Security Policy

## Supported Versions

The plugin ships through npm, so only the latest published version is
supported. Upgrading is a single command:

```bash
npm install -g opencode-stay-awake@latest
```

| Version | Supported |
| ------- | --------- |
| latest  | Yes       |
| older   | No        |

## Reporting a Vulnerability

Please do not open a public issue for a security problem.

Report it privately instead:
<https://github.com/AuroraAeon/opencode-stay-awake/security/advisories/new>

Include the affected version, your platform (macOS or Linux), the OpenCode
version, steps to reproduce, and the impact you observed. Expect an
acknowledgement within 72 hours and a status update at least weekly until the
report is closed.

## Scope

`opencode-stay-awake` holds one OS sleep inhibitor for the lifetime of an
OpenCode server process and nothing else. It has no dependencies, makes no
network requests, and collects no telemetry. Reports about the inhibitor
command construction — argument injection, process handling, or an inhibitor
that leaks after the server exits — are the most relevant to this project.

Reports against OpenCode itself belong in the upstream repository, not here.
