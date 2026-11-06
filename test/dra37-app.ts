/**
 * DRA-37 synthetic "container": one real task-owned process.
 *
 * It serves the application on an internal loopback port. When the actual
 * Drafted runtime has enabled traffic coverage, it loads the runtime's OWN
 * built relay bundle (`app/traffic-relay.js`) and runs its real
 * `startTrafficDaemon` with the runtime's `traffic-daemon.json`, translated
 * from container locations to this host: the journal directory becomes the
 * runtime's host `traffic` directory, the relay listens on the exact URL
 * Drafted assigned, and forwards to the internal application port. In a
 * real deployment Docker supplies that path/port namespace; here the
 * translation is the synthetic part. Health answers only while running.
 *
 * Usage: bun test/dra37-app.ts <public-port> <identity-file> <task-id> <app-dir> <traffic-dir>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [publicPort, identityFile, taskId, appDirectory, trafficDirectory] = [Number(process.argv[2]), process.argv[3]!, process.argv[4]!, process.argv[5], process.argv[6]];
const token = crypto.randomUUID(), startedAt = new Date().toISOString();
const handler = (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname === "/health") return Response.json({ ready: true, taskId, pid: process.pid, token });
  if (url.pathname === "/") return new Response(`<!doctype html><title>DRA-37 ${taskId}</title><h1>DRA-37 synthetic task app</h1><p>task ${taskId}, pid ${process.pid}</p>`, { headers: { "content-type": "text/html" } });
  return new Response("not found", { status: 404 });
};

let stopTraffic: (() => Promise<void>) | undefined, relayed = false;
const record = (extra: object) => writeFileSync(identityFile, JSON.stringify({ pid: process.pid, token, startedAt, port: publicPort, relayed, taskId, ...extra }), { mode: 0o600 });
// Identity first (the transport's start waits for it); like a container, the
// process exists before the runtime publishes its relay configuration.
record({ phase: "starting" });
const daemonFile = appDirectory ? path.join(appDirectory, "traffic-daemon.json") : "";
// Like Drafted's launcher: when the runtime enabled traffic (marker written
// at create), wait for its relay configuration before serving.
// DRA37_RELAY=0 deliberately withholds the relay to prove missing-evidence behaviour.
const relayAllowed = process.env.DRA37_RELAY !== "0";
if (relayAllowed && appDirectory && trafficDirectory && existsSync(path.join(appDirectory, "traffic-enabled"))) {
  const deadline = Date.now() + 120_000;
  while (!existsSync(daemonFile) && Date.now() < deadline) await Bun.sleep(50);
  if (!existsSync(daemonFile)) throw new Error("Traffic was enabled but the runtime never published its relay configuration");
}
const useRelay = relayAllowed && existsSync(daemonFile);
const application = Bun.serve({ hostname: "127.0.0.1", port: useRelay ? 0 : publicPort, fetch: handler });
if (useRelay) {
  const configuration = JSON.parse(readFileSync(daemonFile, "utf8"));
  if (configuration.routes.length !== 1) throw new Error("The DRA-37 fixture maps exactly one relay route to its public port");
  const translated = { ...configuration, directory: trafficDirectory,
    routes: configuration.routes.map((route: Record<string, unknown>) => ({ ...route, listenPort: publicPort, upstreamPort: application.port })) };
  const relay = await import(path.join(appDirectory!, "traffic-relay.js"));
  // Container process accounting is unavailable on the host: the daemon's own
  // fallback then records incomplete activity coverage (never idle).
  stopTraffic = await relay.startTrafficDaemon(translated, { observeActivity: async () => { throw new Error("Container process accounting is unavailable to the DRA-37 host fixture"); }, listenHost: "127.0.0.1" });
  relayed = true;
}
record({ phase: "serving", applicationPort: application.port });
process.on("SIGTERM", () => { void (async () => { await stopTraffic?.(); application.stop(true); process.exit(0); })(); });
