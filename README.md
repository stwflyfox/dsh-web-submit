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

## License

MIT