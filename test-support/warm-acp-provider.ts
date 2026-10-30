/** Real disposable ACP process: retains cwd and conversation between turns. */
import { appendFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
const log = process.env.WARM_ACP_LOG!;
const send = (data: unknown) => process.stdout.write(JSON.stringify(data) + "\n");
const audit = (data: object) => appendFileSync(log, JSON.stringify({ pid: process.pid, cwd: process.cwd(), ...data }) + "\n");
audit({ event: "spawn" });
const session = `fixture-provider-${process.env.REMOTE_AGENT_SESSION_ID}`;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  const request = JSON.parse(line); const { id, method, params } = request;
  audit({ event: method, sessionId: params?.sessionId, requestedCwd: params?.cwd });
  if (id === undefined) continue;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (method === "session/new") send({ jsonrpc: "2.0", id, result: { sessionId: session } });
  else if (method === "session/load") {
    if (params.sessionId !== session) throw new Error("Unexpected replacement session");
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (method === "session/prompt") {
    const text = params.prompt?.map((part: {text?: string}) => part.text ?? "").join("");
    if (text === "capture") {
      const deadline = Date.now() + 20_000;
      while (!existsSync(process.env.WARM_ACP_FINISH!)) { if (Date.now() > deadline) throw new Error("Capture fixture did not finish"); await new Promise(resolve => setTimeout(resolve, 20)); }
    }
    if (text === "hold") await new Promise(resolve => setTimeout(resolve, 1500));
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `continued ${session} at ${process.cwd()}` } } } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else send({ jsonrpc: "2.0", id, result: {} });
}
audit({ event: "stdin-closed" });
