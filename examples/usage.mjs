/*
 * dsh-web-submit usage example.
 *
 * Submits a task to the running dsh web instance and tails the live SSE
 * event stream for that session. Requires Node 18+ (global fetch). Adjust
 * the base URL and port to match your web profile.
 */
const base = "http://127.0.0.1:3080/x/headless";

async function submit(task, { cwd, preset, mode } = {}) {
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ task, cwd, preset, mode }),
  });
  return res.json();
}

async function tail(sessionId) {
  const res = await fetch(`${base}/events?sessionId=${sessionId}`);
  if (!res.body) return;
  for await (const chunk of res.body) {
    process.stdout.write(chunk.toString());
  }
}

const { ok, sessionId } = await submit(
  "Summarize the README",
  { cwd: "C:/my/project", preset: "coding", mode: "queue" },
);

if (ok && sessionId) {
  console.log(`session created: ${sessionId}`);
  await tail(sessionId);
} else {
  console.error("submission failed");
  process.exit(1);
}
