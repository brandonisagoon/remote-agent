/**
 * DRA-31 model-advertising shim around the unchanged synthetic ACP provider
 * test/dra31-legacy-turn-helper.ts. Drafted's committed `implement` workflow
 * pins a model, and acpx applies a model only when the ACP agent advertises
 * it. This shim runs the existing provider as-is and only adds legacy
 * `models` metadata (exactly the given model IDs) to its session/new and
 * session/load responses, answering session/set_model for those IDs locally.
 * Usage: bun dra31-source-turn-helper.ts <private-log> <model-id>...
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

const [log, ...models] = process.argv.slice(2);
if (!log || !models.length) throw new Error("The model shim requires its private log path and at least one model ID");
const audit = (data: object) => appendFileSync(log, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), ...data }) + "\n", { mode: 0o600 });
const child = Bun.spawn([process.execPath, "--no-env-file", path.join(import.meta.dir, "dra31-legacy-turn-helper.ts"), log], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const metadata = { currentModelId: models[0], availableModels: models.map(modelId => ({ modelId, name: modelId })) };
const sessionRequests = new Set<unknown>();
audit({ event: "shim-spawn", providerPid: child.pid, models });
const send = (data: unknown) => process.stdout.write(JSON.stringify(data) + "\n");

const forwardOutput = (async () => {
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = child.stdout.getReader();
  for (let part = await reader.read(); !part.done; part = await reader.read()) {
    buffer += decoder.decode(part.value, { stream: true });
    for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && sessionRequests.delete(message.id) && message.result && typeof message.result === "object") {
        message.result = { ...message.result, models: metadata };
        audit({ event: "shim-models-advertised", id: message.id, sessionId: message.result.sessionId ?? null });
      }
      send(message);
    }
  }
})();

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  const message = JSON.parse(line);
  if (message.method === "session/set_model") {
    audit({ event: "shim-set-model", modelId: message.params?.modelId ?? null });
    if (message.id !== undefined) send(models.includes(message.params?.modelId)
      ? { jsonrpc: "2.0", id: message.id, result: {} }
      : { jsonrpc: "2.0", id: message.id, error: { code: -32602, message: `Synthetic provider does not advertise model ${message.params?.modelId}` } });
    continue;
  }
  if (message.method === "session/new" || message.method === "session/load") sessionRequests.add(message.id);
  child.stdin.write(line + "\n");
}
child.stdin.end();
await child.exited;
await forwardOutput;
audit({ event: "shim-exit", providerExit: child.exitCode });
