/** DRA-37 synthetic original primary (a real ACP process). It never edits the
 * database: on a delivered compute offer it redeems the reservation through
 * the normal compute-claim route on its own control socket, during the turn
 * that delivered it, and audits every prompt and route result. */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const log = process.env.DRA37_LOG!, specs = process.env.DRA37_SPECS!;
const send = (data: unknown) => process.stdout.write(JSON.stringify(data) + "\n");
const audit = (data: object) => appendFileSync(log, JSON.stringify({ at: Date.now(), pid: process.pid, task: process.env.REMOTE_AGENT_TASK_ID ?? `dra37-${process.cwd().split("/").at(-1)}`, sessionEnv: Boolean(process.env.REMOTE_AGENT_SESSION_ID), session: process.env.REMOTE_AGENT_SESSION_ID ?? null, ...data }) + "\n");
const session = `dra37-provider-${process.env.REMOTE_AGENT_SESSION_ID ?? process.cwd().split("/").at(-1)}`;
audit({ event: "spawn", cwd: process.cwd() });

// Seeded sessions have no acpx record, so acpx starts this agent without the
// session environment; the fixture supplies the socket and the task is the
// one whose worktree is this process's cwd (server-side claim validation
// still checks the exact task, offer and recipe).
const taskId = process.env.REMOTE_AGENT_TASK_ID ?? `dra37-${process.cwd().split("/").at(-1)}`;
async function claim(offerId: string) {
  const task = taskId, socket = process.env.REMOTE_AGENT_SOCKET ?? process.env.DRA37_SOCKET;
  if (!socket) return audit({ event: "claim-skipped", reason: "missing socket identity", offerId });
  const file = `${specs}/${task}.json`;
  if (!existsSync(file)) return audit({ event: "claim-skipped", reason: "no recipe for task", offerId });
  const recipe = JSON.parse(readFileSync(file, "utf8"));
  const response = await fetch(`http://primary/api/tasks/${encodeURIComponent(task)}/compute-claim`, { method: "POST", unix: socket,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ ...recipe, offerId }) } as RequestInit & { unix: string });
  audit({ event: "claim", offerId, status: response.status, body: await response.json().catch(() => null) });
}

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  else if (method === "session/new") { audit({ event: "session-new", providerSession: session, requestedCwd: params?.cwd }); send({ jsonrpc: "2.0", id, result: { sessionId: session } }); }
  else if (method === "session/load") send({ jsonrpc: "2.0", id, result: {} });
  else if (method === "session/prompt") {
    const text: string = params.prompt?.map((part: { text?: string }) => part.text ?? "").join("") ?? "";
    audit({ event: "prompt", text: text.slice(0, 400) });
    const offer = /--compute-offer ([0-9a-f-]{36})/.exec(text)?.[1];
    if (offer) await claim(offer).catch(error => audit({ event: "claim-error", offerId: offer, error: String(error) }));
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dra37 turn complete" } } } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else send({ jsonrpc: "2.0", id, result: {} });
}
audit({ event: "stdin-closed" });
