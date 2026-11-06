/**
 * DRA-31 synthetic ACP provider for test/dra31-legacy-turn.rehearsal.ts.
 * A real stdio ACP process the isolated server's acpx spawns as the `codex`
 * provider command: `bun dra31-legacy-turn-helper.ts <private-log>`. It does
 * no work and has no credentials; it only records each prompt it receives so
 * the rehearsal can verify which tooling release a new task was given.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.argv[2];
if (!log) throw new Error("The synthetic provider requires its private log path");
const send = (data: unknown) => process.stdout.write(JSON.stringify(data) + "\n");
const audit = (data: object) => appendFileSync(log, JSON.stringify({ pid: process.pid, cwd: process.cwd(), at: new Date().toISOString(), ...data }) + "\n", { mode: 0o600 });
audit({ event: "spawn", sessionEnv: process.env.REMOTE_AGENT_SESSION_ID ?? null });
const session = `dra31-synthetic-${process.env.REMOTE_AGENT_SESSION_ID ?? process.pid}`;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === "session/prompt") {
    const text = (params?.prompt ?? []).map((part: { text?: string }) => part.text ?? "").join("");
    audit({ event: method, sessionId: params?.sessionId, text });
  } else audit({ event: method, sessionId: params?.sessionId, requestedCwd: params?.cwd });
  if (id === undefined) continue;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (method === "session/new") send({ jsonrpc: "2.0", id, result: { sessionId: session } });
  else if (method === "session/load") send({ jsonrpc: "2.0", id, result: {} });
  else if (method === "session/prompt") {
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "synthetic provider: prompt recorded, no work performed" } } } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else send({ jsonrpc: "2.0", id, result: {} });
}
audit({ event: "stdin-closed" });
