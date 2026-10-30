import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { ServerConfig } from "../lib/config.ts";
import { DevelopmentProjection } from "../lib/development-intent.ts";
import { desktopControl } from "./desktop-control.ts";
import { run } from "./run.ts";
import { findExecutable } from "./paths.ts";

const Task = z.object({ id: z.string(), primarySessionId: z.string(), repositoryId: z.string(), worktreePath: z.string(), toolingRevision: z.string(),
  developmentIntent: DevelopmentProjection });
const Receipt = z.object({ contract: z.literal("remote-agent.tooling-capability/v1"), capability: z.literal("runtime"), source: z.literal("configured-host"),
  taskToolingRevision: z.string(), capabilityRevision: z.string().regex(/^[a-f0-9]{40}$/), checkout: z.string(), adapter: z.string(), instructions: z.string() }).strict();

/** Normal desktop controls immediately use the same reviewed CLI as upkeep.
 * The durable intent remains pending if capability resolution or execution
 * fails; maintenance's raw automation endpoint never enters this path. */
export async function controlDevelopmentCompute(config: ServerConfig, taskId: string, action: "pause" | "resume",
  dependencies = { control: desktopControl, run }) {
  const control = <T>(route: string, method?: string, body?: unknown) => dependencies.control<T>(config.controlIpcPath, route, method, body);
  const route = `/api/tasks/${encodeURIComponent(taskId)}`, requestKey = `desktop-development:${action}:${crypto.randomUUID()}`;
  const saved = Task.parse((await control<{ task: unknown }>(`${route}/automation`, "POST", { action, development: true, requestKey })).task);
  const intent = saved.developmentIntent;
  if (saved.id !== taskId || intent.requestKey !== requestKey || intent.action !== (action === "pause" ? "stop" : "resume")) throw new Error("Recorded development request changed");
  const development = { intentRevision: intent.revision, intentDigest: intent.digest };
  const { receipt: raw } = await control<{ receipt: unknown }>(`/api/sessions/${encodeURIComponent(saved.primarySessionId)}/tooling-capability`, "POST", { capability: "runtime", development });
  const receipt = Receipt.parse(raw), configured = config.repositories[saved.repositoryId]?.tooling;
  if (!configured || receipt.capabilityRevision !== configured.revision || receipt.taskToolingRevision !== saved.toolingRevision) throw new Error("Development runtime capability does not match the configured host and original task");
  const expected = realpathSync(path.join(config.installRoot, "tooling", saved.repositoryId, configured.revision));
  const root = realpathSync(receipt.checkout), adapter = realpathSync(receipt.adapter);
  if (root !== expected || !adapter.startsWith(`${root}${path.sep}`) || adapter !== receipt.adapter) throw new Error("Development runtime adapter escapes its immutable checkout");
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
  const committed = execFileSync("git", ["show", `${receipt.capabilityRevision}:${path.relative(root, adapter)}`], { cwd: root, timeout: 5000, maxBuffer: 1024 * 1024 });
  if (revision !== receipt.capabilityRevision || !readFileSync(adapter).equals(committed)) throw new Error("Development runtime capability bytes changed");
  const check = async () => {
    const current = Task.parse((await control<{ task: unknown }>(route)).task);
    if (current.id !== saved.id || current.primarySessionId !== saved.primarySessionId || current.repositoryId !== saved.repositoryId || current.worktreePath !== saved.worktreePath || current.toolingRevision !== saved.toolingRevision
      || current.developmentIntent.revision !== intent.revision || current.developmentIntent.digest !== intent.digest || current.developmentIntent.requestKey !== requestKey) throw new Error("Development intent changed before the desktop action completed");
    return current;
  };
  await check();
  const bun = findExecutable("bun");
  if (!bun) throw new Error("Bun is unavailable on the task host; the development intent remains pending");
  const result = await dependencies.run(bun, ["--no-env-file", adapter, "upkeep", action, "--socket", config.controlIpcPath, "--task", taskId, "--request-key", requestKey], { cwd: root });
  // Never return arbitrary child stderr/provider output through the desktop.
  if (!result.ok) throw new Error("The saved development request remains pending; inspect its resource status and retry the same intent");
  const output = z.object({ taskId: z.string(), developmentIntent: DevelopmentProjection,
    pending: z.object({ reason: z.literal("owned-sessions-settling"), sessionIds: z.array(z.string()).max(1000) }).strict().optional(),
  }).parse(JSON.parse(result.output));
  if (output.taskId !== taskId || output.developmentIntent.revision !== intent.revision || output.developmentIntent.digest !== intent.digest) throw new Error("Development adapter did not return the saved intent");
  return { task: await check(), development: output };
}
