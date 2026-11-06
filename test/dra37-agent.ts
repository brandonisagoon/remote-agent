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

/** Runtime mode: the agent runs the actual Drafted adapter algorithm for the
 * delivered offer in a separate Bun process, during this delivering turn. */
async function runtimeTurn(offerId: string) {
  const child = Bun.spawn([process.execPath, "--no-env-file", `${import.meta.dir}/dra37-runtime-turn.ts`, "up", offerId], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "/tmp", HOME: process.env.HOME ?? "/tmp", DRA37_DRAFTED_ROOT: process.env.DRA37_DRAFTED_ROOT!,
      DRA37_SOCKET: process.env.REMOTE_AGENT_SOCKET ?? process.env.DRA37_SOCKET!, DRA37_TASK: taskId, DRA37_STATE: process.env.DRA37_STATE!,
      DRA37_RECIPE: `${specs}/${taskId}.recipe.json`, DRA37_APPS: process.env.DRA37_APPS!, ...(process.env.DRA37_RELAY ? { DRA37_RELAY: process.env.DRA37_RELAY } : {}),
      ...(process.env.DRA37_DOCKER_MODE ? { DRA37_DOCKER_MODE: process.env.DRA37_DOCKER_MODE } : {}) } });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  audit({ event: "runtime-up", offerId, code, result: code === 0 ? JSON.parse(stdout.trim().split("\n").at(-1)!) : null, stderr: stderr.slice(-2_000) });
}

/** CLI mode (DRA37_AGENT_MODE=cli): the primary resolves its runtime
 * capability through the normal session route and runs the COMMITTED Drafted
 * CLI from exactly that returned checkout, in its own Bun process, with only
 * the test-only synthetic PlanetScale preload added. Directives come from the
 * prompt: `DRA37-RUNTIME: up|stop`, or a delivered compute offer. */
async function capability() {
  const socket = process.env.REMOTE_AGENT_SOCKET, sessionId = process.env.REMOTE_AGENT_SESSION_ID;
  if (!socket || !sessionId) throw new Error("CLI mode requires the session's REMOTE_AGENT_SOCKET and REMOTE_AGENT_SESSION_ID");
  const response = await fetch(`http://primary/api/sessions/${encodeURIComponent(sessionId)}/tooling-capability`, { method: "POST", unix: socket,
    headers: { "content-type": "application/json" }, body: JSON.stringify({ capability: "runtime" }) } as RequestInit & { unix: string });
  const body = await response.json().catch(() => null) as { receipt?: Record<string, unknown> } | null;
  if (!response.ok || !body?.receipt || typeof body.receipt.checkout !== "string") throw new Error(`Runtime capability unavailable (${response.status}): ${JSON.stringify(body).slice(0, 500)}`);
  return body.receipt as Record<string, unknown> & { checkout: string };
}
/** Test-side handshake: a launched task's ID is known to the fixture only
 * from the launch response, which can arrive after this primary's first turn
 * starts. No Docker-capable command runs until the fixture registered it. */
async function awaitRegistration(task: string) {
  const file = process.env.DRA37_TASKS_FILE;
  if (!file) throw new Error("CLI mode requires DRA37_TASKS_FILE");
  const registered = () => existsSync(file) && readFileSync(file, "utf8").split("\n").filter(Boolean).some(line => JSON.parse(line).taskId === task);
  const startedAt = Date.now(), deadline = startedAt + 120_000;
  while (!registered()) {
    if (Date.now() > deadline) throw new Error(`Task ${task} was never registered by the fixture; no Docker-capable command was run`);
    await Bun.sleep(100);
  }
  audit({ event: "registration-confirmed", waitedMs: Date.now() - startedAt });
}
async function committedCli(label: string, args: string[]) {
  const socket = process.env.REMOTE_AGENT_SOCKET!, task = process.env.REMOTE_AGENT_TASK_ID;
  if (!task) throw new Error("CLI mode requires the session's REMOTE_AGENT_TASK_ID");
  await awaitRegistration(task);
  const receipt = await capability();
  const command = [process.execPath, "--no-env-file", "--preload", process.env.DRA37_PRELOAD!, `${receipt.checkout}/src/cli.ts`, ...args, "--task", task, "--socket", socket];
  const startedAt = Date.now();
  const child = Bun.spawn(command, { cwd: process.cwd(), stdin: "ignore", stdout: "pipe", stderr: "pipe",
    env: { PATH: `${process.env.DRA37_BIN}:${process.env.PATH ?? "/usr/bin:/bin"}`, HOME: process.env.HOME ?? "/tmp", TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "en_US.UTF-8",
      REMOTE_AGENT_SOCKET: socket, REMOTE_AGENT_TASK_ID: task, REMOTE_AGENT_SESSION_ID: process.env.REMOTE_AGENT_SESSION_ID!,
      DRAFTED_RUNTIME_STATE_DIRECTORY: process.env.DRA37_STATE!, DRA37_PLANETSCALE_DIRECTORY: process.env.DRA37_PLANETSCALE_DIRECTORY! } });
  const limit = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 600_000);
  try {
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    let result: unknown = null;
    try { result = code === 0 ? JSON.parse(stdout.trim().split("\n").at(-1)!) : null; } catch { result = { unparsed: stdout.slice(-1_000) }; }
    audit({ event: "cli-run", label, args, capability: receipt, pid: child.pid, startedAt, code, result, stderr: stderr.slice(-3_000) });
  } finally { clearTimeout(limit); }
}
async function cliTurn(text: string) {
  const offer = /--compute-offer ([0-9a-f-]{36})/.exec(text)?.[1] ?? /\(offer ([0-9a-f-]{36})\)/.exec(text)?.[1];
  const saved = /resource resume --key (\S+) --compute-offer/.exec(text)?.[1];
  const directive = /DRA37-RUNTIME: (up|stop)\b/.exec(text)?.[1];
  if (offer) return committedCli("offer", saved ? ["resource", "resume", "--key", saved, "--compute-offer", offer] : ["runtime", "up", "--config", process.env.DRA37_RECIPE_FILE!, "--compute-offer", offer]);
  if (directive === "up") return committedCli("runtime-up", ["runtime", "up", "--config", process.env.DRA37_RECIPE_FILE!]);
  if (directive === "stop") return committedCli("runtime-stop", ["runtime", "stop"]);
  audit({ event: "no-directive" });
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
    const offer = /--compute-offer ([0-9a-f-]{36})/.exec(text)?.[1] ?? /\(offer ([0-9a-f-]{36})\)/.exec(text)?.[1];
    if (offer && process.env.DRA37_AGENT_BARRIER && existsSync(process.env.DRA37_AGENT_BARRIER)) {
      // Test-only delayed response: this delivered offer turn stays in
      // progress (no claim, no answer) until the fixture releases it.
      const heldAt = Date.now();
      audit({ event: "offer-held", offerId: offer });
      while (existsSync(process.env.DRA37_AGENT_BARRIER) && Date.now() - heldAt < 600_000) await Bun.sleep(200);
      audit({ event: "offer-released", offerId: offer, waitedMs: Date.now() - heldAt });
    }
    if (process.env.DRA37_AGENT_MODE === "cli") await cliTurn(text).catch(error => audit({ event: "cli-error", error: String(error).slice(0, 2_000) }));
    else if (offer && process.env.DRA37_DRAFTED_ROOT) await runtimeTurn(offer).catch(error => audit({ event: "runtime-error", offerId: offer, error: String(error) }));
    else if (offer) await claim(offer).catch(error => audit({ event: "claim-error", offerId: offer, error: String(error) }));
    send({ jsonrpc: "2.0", method: "session/update", params: { sessionId: session, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dra37 turn complete" } } } });
    send({ jsonrpc: "2.0", id, result: { stopReason: "end_turn" } });
  } else send({ jsonrpc: "2.0", id, result: {} });
}
audit({ event: "stdin-closed" });
