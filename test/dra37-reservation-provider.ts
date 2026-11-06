/**
 * DRA-37 synthetic ACP provider for test/dra37-reservation-restart.rehearsal.ts.
 * Usage: bun dra37-reservation-provider.ts <private-control-directory>
 *
 * Ordinary prompts end immediately. A compute-offer prompt ("... (offer
 * <uuid>) ...") is held at an explicit private barrier: the provider writes
 * seen-<offer>-<n>.json and waits for decide-<offer>-<n>.json from the
 * rehearsal, then either ends the turn without claiming ("end") or calls the
 * normal compute-claim route on its own session's control socket
 * (REMOTE_AGENT_SOCKET), optionally discarding the first acknowledgment and
 * claiming again ("claim", times 2). A session/cancel or closed stdin ends the
 * wait. It performs no runtime, Docker or product work: a successful claim is
 * startup intent only, never a physical start.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const control = process.argv[2];
if (!control) throw new Error("The reservation provider requires its private control directory");
const log = path.join(control, "provider.jsonl");
const audit = (data: object) => appendFileSync(log, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...data }) + "\n", { mode: 0o600 });
const send = (data: unknown) => process.stdout.write(JSON.stringify(data) + "\n");
const socket = process.env.REMOTE_AGENT_SOCKET, runtimeSession = process.env.REMOTE_AGENT_SESSION_ID ?? null;
const session = `dra37-reservation-${runtimeSession ?? process.pid}`;
let closed = false;
const cancelled = new Set<string>();
audit({ event: "spawn", sessionEnv: runtimeSession, socket: Boolean(socket) });

type Decision = { action: "end" } | { action: "claim"; taskId: string; request: Record<string, unknown>; times: 1 | 2 };
async function claim(taskId: string, body: Record<string, unknown>) {
  const response = await fetch(`http://control/api/tasks/${encodeURIComponent(taskId)}/compute-claim`, { method: "POST", unix: socket, headers: { "content-type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

async function prompt(id: unknown, sessionId: string, text: string) {
  const offer = /\(offer ([0-9a-f-]{36})\)/.exec(text)?.[1] ?? null;
  audit({ event: "session/prompt", sessionId, offer, textLength: text.length });
  let stopReason = "end_turn";
  if (offer) {
    let n = 1; while (existsSync(path.join(control, `seen-${offer}-${n}.json`))) n++;
    writeFileSync(path.join(control, `seen-${offer}-${n}.json`), JSON.stringify({ offer, n, sessionEnv: runtimeSession, at: new Date().toISOString() }), { mode: 0o600 });
    const decisionFile = path.join(control, `decide-${offer}-${n}.json`);
    const deadline = Date.now() + 240_000;
    while (!existsSync(decisionFile) && !closed && !cancelled.has(sessionId) && Date.now() < deadline) await Bun.sleep(100);
    if (closed) { audit({ event: "barrier-abandoned", offer, n, reason: "stdin-closed" }); return; }
    if (cancelled.has(sessionId)) { cancelled.delete(sessionId); stopReason = "cancelled"; audit({ event: "barrier-cancelled", offer, n }); }
    else if (!existsSync(decisionFile)) { stopReason = "cancelled"; audit({ event: "barrier-timeout", offer, n }); }
    else {
      const decision = JSON.parse(readFileSync(decisionFile, "utf8")) as Decision;
      audit({ event: "decision", offer, n, action: decision.action });
      if (decision.action === "claim") {
        const results = [];
        for (let attempt = 1; attempt <= decision.times; attempt++) {
          const result = await claim(decision.taskId, { offerId: offer, ...decision.request });
          // The first acknowledgment of a two-attempt decision is discarded by
          // this client (a client-side lost response) before retrying.
          results.push({ attempt, discarded: decision.times === 2 && attempt === 1, ...result });
        }
        writeFileSync(path.join(control, `claimed-${offer}-${n}.json`), JSON.stringify(results), { mode: 0o600 });
        audit({ event: "claim-results", offer, n, statuses: results.map(value => value.status) });
      }
    }
  }
  send({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: offer ? `reservation provider handled offer ${offer}` : "reservation provider: no work" } } } });
  send({ jsonrpc: "2.0", id, result: { stopReason } });
}

const lines = createInterface({ input: process.stdin });
lines.on("line", line => {
  if (!line.trim()) return;
  const { id, method, params } = JSON.parse(line);
  if (method === "session/prompt") {
    const text = (params?.prompt ?? []).map((part: { text?: string }) => part.text ?? "").join("");
    void prompt(id, params?.sessionId ?? session, text).catch(error => { audit({ event: "prompt-error", error: String(error) }); send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } }); });
    return;
  }
  audit({ event: method, sessionId: params?.sessionId ?? null });
  if (method === "session/cancel") { cancelled.add(params?.sessionId ?? session); return; }
  if (id === undefined) return;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (method === "session/new") send({ jsonrpc: "2.0", id, result: { sessionId: session } });
  else send({ jsonrpc: "2.0", id, result: {} });
});
lines.on("close", () => { closed = true; audit({ event: "stdin-closed" }); setTimeout(() => process.exit(0), 200); });
