import { existsSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { readConfig, parseServiceFile } from "../lib/config.ts";
import { readConfigDocument, writeConfigDocument, readRepoConfigDocument, writeRepoConfigDocument } from "../lib/config-file.ts";
import { concealHostSecrets, restoreHostSecrets, type DesktopTask } from "../lib/desktop-host.ts";
import { checkSkills } from "../lib/skills/check.ts";
import { desktopControl } from "./desktop-control.ts";
import { runChecks } from "./checks.ts";
import { checkForUpdates, restartService, serviceStatus } from "./service.ts";
import { run, runOrThrow } from "./run.ts";
import { listProviderModels } from "./provider-models.ts";
import { tunnelInfo } from "./tunnel-info.ts";

const text = z.string().min(1);
const id = z.string().min(1).max(200);
const save = z.object({ expectedRevision: text, value: z.unknown() }).strict();
export const DesktopOperationSchema = z.discriminatedUnion("method", [
  z.object({ method: z.enum(["host:status", "config:get", "config:path", "repo-configs:get", "management:checks", "tasks:list"]), args: z.tuple([]) }).strict(),
  z.object({ method: z.literal("config:save"), args: z.tuple([save]) }).strict(),
  z.object({ method: z.literal("repo-config:save"), args: z.tuple([save.extend({ id })]) }).strict(),
  z.object({ method: z.literal("sessions:list"), args: z.tuple([z.string().nullish()]) }).strict(),
  z.object({ method: z.literal("tasks:activity"), args: z.tuple([id]) }).strict(),
  z.object({ method: z.literal("tasks:control"), args: z.tuple([id, z.enum(["pause", "resume", "close"])]) }).strict(),
  z.object({ method: z.literal("tasks:answer"), args: z.tuple([id, id, text.max(100_000)]) }).strict(),
  z.object({ method: z.literal("tasks:instruct"), args: z.tuple([id, id, text.max(100_000)]) }).strict(),
  z.object({ method: z.literal("tasks:resolve"), args: z.tuple([id, id, z.enum(["acknowledge", "cancel", "retry"]), text.max(2000)]) }).strict(),
  z.object({ method: z.literal("tasks:preview"), args: z.tuple([id, id]) }).strict(),
  z.object({ method: z.literal("skills:check"), args: z.tuple([text, text]) }).strict(),
  z.object({ method: z.literal("provider:models"), args: z.tuple([z.enum(["codex", "claude"])]) }).strict(),
  z.object({ method: z.literal("tunnel:info"), args: z.tuple([text]) }).strict(),
  z.object({ method: z.literal("fs:list"), args: z.tuple([z.string(), z.enum(["file", "folder"])]) }).strict(),
  z.object({ method: z.literal("repository:validate"), args: z.tuple([text]) }).strict(),
  z.object({ method: z.literal("management:run"), args: z.tuple([z.enum(["status", "doctor", "check-update", "restart"])]) }).strict(),
]);

function repositoryRoots(file: string) {
  const document = readConfigDocument(file);
  if (!document.valid) throw new Error("Repair the host configuration before editing repository settings");
  return Object.fromEntries(Object.entries(document.value.repositories).map(([key, repo]) => {
    const raw = repo.tooling?.root ?? repo.root;
    return [key, raw.startsWith("~") ? path.join(os.homedir(), raw.slice(1)) : path.resolve(path.dirname(file), raw)];
  }));
}

function safeDocument(file: string) {
  const document = readConfigDocument(file);
  if (!document.valid) return { ...document, raw: "", error: "Host configuration is invalid. Repair it on the selected machine." };
  return { ...document, raw: "", value: concealHostSecrets(document.value) };
}

export async function desktopOperation(file: string, raw: unknown, serviceLabel?: string): Promise<unknown> {
  const operation = DesktopOperationSchema.parse(raw);
  const args = operation.args as unknown[];
  if (operation.method === "config:path") return file;
  if (operation.method === "config:get") return safeDocument(file);
  if (operation.method === "config:save") {
    const input = save.parse(args[0]);
    const current = readConfigDocument(file);
    if (!current.valid || current.revision !== input.expectedRevision) throw new Error("Configuration changed on the host; reload before saving");
    const value = parseServiceFile(restoreHostSecrets(input.value, current.value));
    if (value.machine.id !== current.value.machine.id) throw new Error("Keep this machine's identity unchanged while managing it remotely");
    writeConfigDocument({ file, expectedRevision: input.expectedRevision, value });
    return safeDocument(file);
  }
  if (operation.method === "repo-configs:get") return Object.fromEntries(Object.entries(repositoryRoots(file)).map(([key, root]) => [key, { ...readRepoConfigDocument(root), root }]));
  if (operation.method === "repo-config:save") {
    const input = save.extend({ id }).parse(args[0]);
    const root = repositoryRoots(file)[input.id];
    if (!root) throw new Error("Unknown repository on this machine");
    return writeRepoConfigDocument({ root, ...input });
  }
  if (operation.method === "fs:list") {
    const requested = (args[0] as string) || os.homedir();
    let directory = path.resolve(requested.startsWith("~") ? path.join(os.homedir(), requested.slice(1)) : requested);
    if (statSync(directory).isFile()) directory = path.dirname(directory);
    return { path: directory, parent: path.dirname(directory), entries: readdirSync(directory, { withFileTypes: true }).filter((entry) => args[1] === "file" || entry.isDirectory()).map((entry) => ({ name: entry.name, path: path.join(directory, entry.name), directory: entry.isDirectory() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)).slice(0, 500) };
  }
  if (operation.method === "repository:validate") {
    const root = path.resolve(args[0] as string);
    return existsSync(path.join(root, ".git")) ? { repository: { root, name: path.basename(root) } } : { error: "not-a-repository" };
  }
  const config = readConfig();
  const control = <T>(route: string, method?: string, body?: unknown) => desktopControl<T>(config.controlIpcPath, route, method, body);
  switch (operation.method) {
    case "host:status": {
      let serverAvailable = false;
      try { await control("/health"); serverAvailable = true; } catch { /* SSH can recover an unavailable daemon. */ }
      return { connected: true, serverAvailable, machineId: config.machine };
    }
    case "sessions:list": return (await control<{ sessions: unknown[] }>(`/api/sessions?includeClosed=true${args[0] ? `&repositoryId=${encodeURIComponent(args[0] as string)}` : ""}`)).sessions;
    case "tasks:list": return (await control<{ tasks: DesktopTask[] }>("/api/tasks")).tasks;
    case "tasks:activity": return control(`/api/tasks/${encodeURIComponent(args[0] as string)}/activity`);
    case "tasks:control": return control(`/api/tasks/${encodeURIComponent(args[0] as string)}/automation`, "POST", { action: args[1] });
    case "tasks:answer": return control(`/api/tasks/${encodeURIComponent(args[0] as string)}/questions/${encodeURIComponent(args[1] as string)}/answer`, "POST", { answer: args[2] });
    case "tasks:instruct": return control(`/api/tasks/${encodeURIComponent(args[0] as string)}/instructions`, "POST", { requestKey: args[1], text: args[2] });
    case "tasks:resolve": return control(`/api/tasks/${encodeURIComponent(args[0] as string)}/instructions/${encodeURIComponent(args[1] as string)}/resolve`, "POST", { action: args[2], reason: args[3] });
    case "tasks:preview": {
      const { task } = await control<{ task: DesktopTask }>(`/api/tasks/${encodeURIComponent(args[0] as string)}`);
      const resource = task.resources.find((entry) => entry.id === args[1] && entry.kind === "local-http" && entry.state !== "released");
      if (!resource) throw new Error("Preview resource is no longer available");
      const url = new URL(resource.externalId);
      if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname) || url.username || url.password || Number(url.port || 80) === config.port) throw new Error("Preview must be a task-owned loopback HTTP endpoint");
      return url.href;
    }
    case "skills:check": return checkSkills(args[0] as string, args[1] as string);
    case "provider:models": return listProviderModels(args[0] as string, parseServiceFile(JSON.parse(readConfigDocument(file).raw)).providers);
    case "tunnel:info": return tunnelInfo(args[0] as string);
    case "management:checks": {
      if (!serviceLabel) return runChecks();
      const status = await desktopOperation(file, { method: "host:status", args: [] });
      const registered = await run("launchctl", ["print", `gui/${process.getuid?.()}/${serviceLabel}`]);
      return [
        { id: "config", label: "Configuration", status: "ok", detail: file },
        { id: "server", label: "Server", status: (status as { serverAvailable: boolean }).serverAvailable ? "ok" : "fail", detail: config.controlIpcPath },
        { id: "service", label: "Service", status: registered.exitCode === 0 ? "ok" : "fail", detail: serviceLabel },
        { id: "repositories", label: "Repositories", status: Object.values(config.repositories).every((repo) => existsSync(repo.root)) ? "ok" : "fail", detail: `${Object.keys(config.repositories).length} configured on ${config.machine}` },
        { id: "acp", label: "ACP socket", status: existsSync(config.acpIpcPath) ? "ok" : "fail", detail: config.acpIpcPath },
      ];
    }
    case "management:run": {
      const action = args[0];
      if (action === "status" && !serviceLabel) return serviceStatus();
      if (action === "doctor" || action === "status") {
        const checks = await desktopOperation(file, { method: "management:checks", args: [] }, serviceLabel) as Array<{ status: string }>;
        return { ok: checks.every((check) => check.status !== "fail"), summary: "Checks completed on this machine", detail: JSON.stringify(checks, null, 2) };
      }
      if (action === "check-update") return checkForUpdates();
      const { tasks } = await control<{ tasks: DesktopTask[] }>("/api/tasks");
      const { sessions } = await control<{ sessions: Array<{ status: string }> }>("/api/sessions");
      if (tasks.some((task) => ["human", "draining"].includes(task.controlMode)) || sessions.some((session) => ["active", "provisioning"].includes(session.status))) throw new Error("Pause active work and return browser control before restarting this machine's server");
      if (!serviceLabel) return restartService();
      const manifest = path.join(os.homedir(), "Library/LaunchAgents", `${serviceLabel}.plist`);
      const parsed = JSON.parse(await runOrThrow("plutil", ["-convert", "json", "-o", "-", manifest]));
      if (parsed.Label !== serviceLabel || parsed.EnvironmentVariables?.REMOTE_AGENT_CONFIG !== file) throw new Error("Service does not belong to the selected configuration");
      await runOrThrow("launchctl", ["kickstart", "-k", `gui/${process.getuid?.()}/${serviceLabel}`]);
      return { ok: true, summary: "Restart requested on this machine; reconnecting to its server" };
    }
  }
}
