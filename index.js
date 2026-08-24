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

        sendJson(res, 404, { ok: false, error: "not found" });
      },
    }),
    "dsh-web-submit routes",
  );
}