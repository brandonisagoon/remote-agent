/** DRA-37 task-owned synthetic application: a real loopback HTTP process.
 * It answers health only while it is actually running and records its exact
 * identity (pid, start token, port) for the transport and the observer. */
import { writeFileSync } from "node:fs";

const [port, identityFile, taskId] = [Number(process.argv[2]), process.argv[3]!, process.argv[4]!];
const token = crypto.randomUUID(), startedAt = new Date().toISOString();
const server = Bun.serve({ hostname: "127.0.0.1", port, fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ready: true, taskId, pid: process.pid, token });
  if (url.pathname === "/") return new Response(`<!doctype html><title>DRA-37 ${taskId}</title><h1>DRA-37 synthetic task app</h1><p>task ${taskId}, pid ${process.pid}</p>`, { headers: { "content-type": "text/html" } });
  return new Response("not found", { status: 404 });
} });
writeFileSync(identityFile, JSON.stringify({ pid: process.pid, token, startedAt, port: server.port, taskId }), { mode: 0o600 });
process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
