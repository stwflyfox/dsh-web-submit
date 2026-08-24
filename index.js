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
 * The plugin drives the process's own built-in /api RPC surface over a
 * loopback HTTP request (same paths dsh-x / the web UI client use), which
 * keeps it in exact sync with the UI and needs no private service wiring.
 * Loopback requests only.
 */
import z from "@deepseek-ai/schemastery";
import { randomUUID } from "node:crypto";

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

  /** In-process RPC against the harness's own /api surface. */
  async function rpc(method, payload) {
    const base = `http://127.0.0.1:${ctx.webServer.port}`;
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "client-request",
        rpcId: randomUUID(),
        method,
        payload,
      }),
    });
    const resp = await res.json();
    const result = resp && resp.result;
    if (!result || !result.ok) {
      const err = result && result.error;
      throw new Error(
        err && err.message ? err.message : JSON.stringify(err || resp || "rpc failed"),
      );
    }
    return result.value;
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
            const createReq = { cwd: body.cwd || process.cwd() };
            if (body.preset) createReq.agentPreset = body.preset;
            const created = await rpc("session.create", createReq);
            await rpc("session.prompt", {
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
            const history = await rpc("session.history", {
              sessionId: sid,
              maxMessages: 60,
            });
            const events = (history.events || []).map((e) => {
              const ev = e.event || e;
              return { type: ev.type, seq: ev.seq, time: ev.time, data: ev.data };
            });
            sendJson(res, 200, {
              ok: true,
              sessionId: sid,
              events,
              hasMore: !!history.hasMore,
            });
          } catch (err) {
            sendJson(res, 500, { ok: false, error: String((err && err.message) || err) });
          }
          return;
        }

        sendJson(res, 404, { ok: false, error: "not found" });
      },
    }),
    "dsh-web-submit routes",
  );
}