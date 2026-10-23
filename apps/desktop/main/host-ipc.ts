import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { DesktopHostManager } from "./hosts.ts";
import { desktopOperation } from "../../../management/desktop-operations.ts";
import { buildEditorDeepLink } from "../../../lib/machines/editor-link.ts";
import { forwardPreview } from "./preview-forward.ts";
import { withConfigFile } from "../../../lib/config-scope.ts";
import { DesktopRepositoryReferenceSchema } from "../../../lib/desktop-sessions.ts";
import { desktopRepositoryReference, desktopRepositorySessions } from "../../../management/desktop-sessions.ts";

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
export function installHostIpc(hosts: DesktopHostManager, handlers: Map<string, Handler>, defaultLocalFile: string) {
  ipcMain.handle("hosts:list", () => hosts.list());
  ipcMain.handle("sessions:for-host", async (_event, value) => {
    const { hostId, repository } = z.object({ hostId: z.string(), repository: DesktopRepositoryReferenceSchema }).strict().parse(value);
    const host = hosts.get(hostId);
    const sessions = host.kind === "ssh"
      ? await hosts.repositorySessions(hostId, repository)
      : await desktopRepositorySessions(host.configPath ?? defaultLocalFile, repository);
    return sessions;
  });
  ipcMain.handle("host:call", async (event, value) => {
    const { hostId, channel, args } = z.object({ hostId: z.string(), channel: z.string(), args: z.array(z.unknown()) }).strict().parse(value);
    const host = hosts.get(hostId);
    if (host.kind === "ssh") {
      if (channel === "host:status") return hosts.status(hostId);
      if (["config:open-in-editor", "config:reveal"].includes(channel)) { await shell.openExternal(buildEditorDeepLink("ssh", "zed", host.sshHost, host.configPath)); return null; }
      if (channel === "shell:open-path") { const target = z.string().startsWith("/").parse(args[0]); await shell.openExternal(buildEditorDeepLink("ssh", "zed", host.sshHost, target)); return ""; }
      if (["shell:open-with", "repository:pick", "fs:pick-file", "fs:pick-folder", "skills:pick-root", "management:open-terminal"].includes(channel)) throw new Error("Use this machine's path picker or an SSH-capable editor");
      if (channel === "tasks:preview") {
        const url = await hosts.request<string>(hostId, channel, args);
        return forwardPreview(host, url);
      }
      if (!channel.startsWith("keybindings:") && channel !== "editors:detect") return hosts.request(hostId, channel, args);
    }
    const file = host.kind === "local" ? host.configPath ?? defaultLocalFile : defaultLocalFile;
    return withConfigFile(file, async () => {
      if (channel === "sessions:repository-reference") return desktopRepositoryReference(file, z.string().min(1).parse(args[0]));
      if (["host:status", "tasks:list", "tasks:activity", "tasks:control", "tasks:answer", "tasks:instruct", "tasks:resolve", "tasks:preview", "fs:list", "repository:validate"].includes(channel)) {
        try { return await desktopOperation(file, { method: channel, args }); }
        catch (error) { if (channel === "host:status") return { connected: true, serverAvailable: false, detail: error instanceof Error ? error.message : String(error) }; throw error; }
      }
      const handler = handlers.get(channel);
      if (!handler) throw new Error("Unsupported desktop action");
      return handler(event, ...args);
    });
  });
}
