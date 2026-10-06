/**
 * dsh-web-submit — DeepSeek Harness plugin.
 *
 * Lets an external command line (or any HTTP client) run a task through the
 * LIVE `dsh web` process instead of a separate headless process:
 *
 *   POST /x/headless            { task, cwd?, preset?, mode? } -> { sessionId }
 *   GET  /x/headless/status     ?sessionId=...  -> latest session events
 *   GET  /x/headless/events     ?sessionId=...  -> SSE live event stream
 *
 * Because the session is created inside the web process itself, the Web UI
 * shows it in real time (same live_sessions store, same event broadcast), and
 * permission / approval questions appear in the Web UI for the user.
 *
 * The plugin drives the process's own built-in session Remote through the DSH
 * host's in-process Typert Gateway (`ctx.typertGateway.invoke`) — the same
 * dispatch the Web UI client itself uses — so no loopback HTTP round-trip and
 * no re-entry into the browser-guarded HTTP transport is needed.
 *
 * `POST /x/headless` resolves `body.cwd` against the installed DSH workspace
 * registry and creates the session with `workspaceId` — never with `cwd`, and
 * never with both — so DSH itself attaches the new session to that Workspace
 * and the conversation is grouped in the Web UI instead of 未分组. A cwd that
 * matches no registered Workspace, or more than one, fails closed.
 *
 * Loopback requests only.
 */
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";

export const name = "dsh-web-submit";

export const inject = ["webServer"];

export const Config = z.object({
  routePrefix: z.string().default("/x"),
  maxBodyBytes: z.number().default(1_048_576),
  pollIntervalMs: z.number().default(1500),
});

function isLoopbackHost(host) {
  if (!host) return false;
  try {
    const u = new URL(`http://${host}`);
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "::1";
  } catch {
    return false;
  }
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

export async function apply(ctx, config) {
  const prefix = config.routePrefix.replace(/\/+$/, "");
  const HEADLESS = `${prefix}/headless`;
  const STATUS = `${prefix}/headless/status`;
  const EVENTS = `${prefix}/headless/events`;

  /**
   * In-process Remote dispatch through the harness's own Typert Gateway.
   *
   * `typertGateway` is resolved lazily instead of being declared in `inject`,
   * so an unavailable Gateway can never prevent this plugin from loading and
   * registering its routes; a missing service fails the single request instead.
   */
  async function remote(namespace, method, request) {
    const gateway = ctx.get("typertGateway");
    if (!gateway || typeof gateway.invoke !== "function") {
      throw new Error("typertGateway service is unavailable in this process");
    }
    return gateway.invoke({ namespace, method, args: { request } });
  }

  /**
   * Resolve the DSH Workspace that owns one directory.
   *
   * `session.create` accepts `workspaceId` or `cwd`, never both, and only
   * `workspaceId` makes DSH attach the created session to a Workspace (which
   * is what groups the conversation in the Web UI). The id is therefore
   * resolved dynamically from the live workspace registry — never hard-coded —
   * by exact normalized-absolute-path comparison against each Workspace's own
   * `path`, never against its display title.
   *
   * Resolution fails closed: an unmatched or ambiguous directory throws, and
   * the caller never falls back to a cwd-only, ungrouped session.
   */
  function resolveWorkspaceForCwd(requestedCwd) {
    const registry = ctx.get("workspaceRegistry");
    if (!registry || typeof registry.list !== "function") {
      throw new Error("workspaceRegistry service is unavailable in this process");
    }
    const target = resolvePath(requestedCwd);
    const matches = registry.list().filter((workspace) => {
      if (!workspace || typeof workspace.path !== "string") return false;
      return resolvePath(workspace.path) === target;
    });
    if (matches.length === 0) {
      throw new Error(`No DSH workspace registered for cwd "${target}"`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Ambiguous DSH workspace for cwd "${target}": ${matches.length} registered workspaces share that path`,
      );
    }
    const workspace = matches[0];
    if (typeof workspace.id !== "string" || !workspace.id) {
      throw new Error(`DSH workspace registered for cwd "${target}" has no id`);
    }
    return workspace;
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: "prefix",
      path: prefix,
      handler: async (req, res) => {
        if (!isLoopbackHost(req.headers.host)) {
          sendJson(res, 403, { ok: false, error: "forbidden" });
          return;
        }
        const url = new URL(req.url, "http://localhost");
        const path = url.pathname;

        // POST /x/headless : create a session in the web process and prompt it.
        if (req.method === "POST" && path === HEADLESS) {
          try {
            const body = await readBody(req, config.maxBodyBytes);
            const task = typeof body.task === "string" ? body.task.trim() : "";
            if (!task) {
              sendJson(res, 400, { ok: false, error: "missing 'task'" });
              return;
            }
            // cwd -> registered Workspace; the create request carries the
            // resolved `workspaceId` only (DSH then uses `workspace.path` as
            // the session cwd and attaches the session to that Workspace).
            const workspace = resolveWorkspaceForCwd(body.cwd || process.cwd());
            const createReq = { workspaceId: workspace.id };
            if (body.preset) createReq.agentPreset = body.preset;
            const created = await remote("session", "create", createReq);
            await remote("session", "prompt", {
              requestId: randomUUID(),
              sessionId: created.sessionId,
              mode: body.mode === "steer" ? "steer" : "queue",
              content: [{ type: "text", text: task }],
            });
            sendJson(res, 200, {
              ok: true,
              sessionId: created.sessionId,
              agentPreset: created.agentPreset || null,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
          return;
        }

        // GET /x/headless/status?sessionId=...
        if (req.method === "GET" && path === STATUS) {
          const sid = url.searchParams.get("sessionId");
          if (!sid) {
            sendJson(res, 400, { ok: false, error: "missing sessionId" });
            return;
          }
          try {
            const page = await remote("session", "page", {
              address: { kind: "session", sessionId: sid },
              throughSeq: -1,
              maxMessages: 60,
            });
            const events = (page.records || []).map((e) => {
              const ev = e.event || e;
              return { type: ev.type, seq: ev.seq, time: ev.time, data: ev.data };
            });
            sendJson(res, 200, {
              ok: true,
              sessionId: sid,
              events,
              hasMore: !!page.hasMore,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
          return;
        }

        // GET /x/headless/events?sessionId=...  (SSE live stream, poll-based)
        if (req.method === "GET" && path === EVENTS) {
          const sid = url.searchParams.get("sessionId");
          if (!sid) {
            sendJson(res, 400, { ok: false, error: "missing sessionId" });
            return;
          }
          res.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write("retry: 2000\n\n");
          const seen = new Set();
          let sawEnd = false;
          let drain = 0;
          try {
            while (!res.writableEnded) {
              const page = await remote("session", "page", {
                address: { kind: "session", sessionId: sid },
                throughSeq: -1,
                maxMessages: 40,
              });
              for (const e of page.records || []) {
                const ev = e.event || e;
                if (seen.has(ev.seq)) continue;
                seen.add(ev.seq);
                const frame = { type: ev.type, seq: ev.seq, time: ev.time, data: ev.data };
                res.write(`data: ${JSON.stringify(frame)}\n\n`);
                if (ev.type === "turn/end") {
                  sawEnd = true;
                  drain = 0;
                }
              }
              if (sawEnd) {
                drain += 1;
                if (drain >= 3) {
                  res.write(`data: ${JSON.stringify({ type: "stream/end", sessionId: sid })}\n\n`);
                  break;
                }
              }
              await new Promise((r) => setTimeout(r, config.pollIntervalMs));
            }
          } catch {
            // stream ends on error; client can fall back to /status
          } finally {
            res.end();
          }
          return;
        }

        sendJson(res, 404, { ok: false, error: "not found" });
      },
    }),
    "dsh-web-submit routes",
  );
}
