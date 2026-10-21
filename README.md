# dsh-web-submit

DeepSeek Harness plugin that lets you drive the **running** `dsh web` instance
from the command line — the task executes inside the web process, so the Web
UI shows it live (same sessions store, same event stream), and permission /
approval questions appear in the Web UI.

No separate headless process, no webhook glue: one plugin, three endpoints.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `POST` | `/x/headless` | `{"task": "...", "cwd": "...", "preset": "standard", "mode": "queue"}` → `{"ok": true, "sessionId": "session-..."}` |
| `GET` | `/x/headless/status?sessionId=...` | Latest session events (non-streaming poll) |
| `GET` | `/x/headless/events?sessionId=...` | SSE live event stream; ends after `turn/end` |

Loopback requests only (`127.0.0.1` / `localhost`), same trust posture as the
built-in `/api` surface. The plugin reuses the in-process `ApiProxyService`,
so it stays identical to the UI's own session/prompt path.

## Install

```bash
dsh plugin --profile web add file:C:/dsh-web-submit
```

The bundle patch rule (`cordis.patch.yml`) is applied automatically by `dsh plugin add`, so no manual edit to the host profile is needed.

Restart `dsh web` (`~/.dsh/start-web.cmd`) to load the plugin.

## Example (CLI)

```bash
# submit a task
curl -s -X POST http://127.0.0.1:3080/x/headless \
  -H 'content-type: application/json' \
  -d '{"task":"Summarize the README","cwd":"C:/my/project","preset":"coding"}'

# tail it live
curl -sN "http://127.0.0.1:3080/x/headless/events?sessionId=session-xxx"
```

While it runs, open the Web UI: the session is visible in real time, exactly
as if you had typed the task there.

## Config

| Key | Default | Meaning |
|---|---|---|
| `routePrefix` | `/x` | Route prefix for all endpoints |
| `maxBodyBytes` | `1048576` | Max request body size |

## Optional: shell wrapper for `dsh headless` (POSIX)

`examples/headless-shim.sh` makes `dsh headless "task"` submit through this plugin instead of
starting a separate process. The session then appears in the Web UI, while the command still waits
for `turn/end`, so it can be used synchronously from scripts.

It is purely client-side: the plugin cannot register a `dsh` subcommand itself, because dsh's CLI
resolves `headless` before any plugin is loaded. That is why the wrapper has to sit on `PATH`.

```bash
install -m 0755 examples/headless-shim.sh ~/.local/bin/dsh
type -a dsh     # ~/.local/bin/dsh must come first, before the real CLI
```

| Input | Result |
|---|---|
| `dsh headless "task"` / `dsh --profile headless "task"` | `POST /x/headless`, wait for `turn/end` |
| task on stdin (`… \| dsh headless -`, or no arguments plus a pipe) | same |
| `--json` / `--session-id` / `-h` / `--help`, unknown options, non-headless subcommands | passed through to the real CLI |
| plugin unreachable, or the submission is rejected | warns on stderr, falls back to the real CLI |

Task-level options the wrapper consumes (never forwarded): `-C/--cwd`, `--preset`, `--permission`,
`--provider`/`--model`, `--effort`, `--timeout`. Environment: `DSH_WEB_SUBMIT_URL`
(default `http://127.0.0.1:3080`), `DSH_HEADLESS_CWD`, `DSH_HEADLESS_TIMEOUT`, `DSH_HEADLESS_CLI`.

Notes:

- POSIX shells only (Linux, macOS, WSL). Windows callers keep using `curl` or their own script.
- systemd/launcher units that start `dsh` by absolute path bypass the wrapper — deliberately.
- Uninstall with `rm ~/.local/bin/dsh`.
- `--permission` (and the other task options) only matter for plugin versions that support them;
  older versions simply ignore unknown body fields, so the submission still succeeds.

## License

MIT