import { ipcMain, shell, type IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import { DesktopHostManager } from "./hosts.ts";
import { desktopOperation } from "../../../management/desktop-operations.ts";
import { buildEditorDeepLink } from "../../../lib/machines/editor-link.ts";
import { forwardPreview, closePreviewForwards } from "./preview-forward.ts";

type Handler = (event: IpcMainInvokeEvent, ...args: any[]) => unknown;
export function installHostIpc(hosts: DesktopHostManager, handlers: Map<string, Handler>, localFile: () => string) {
  ipcMain.handle("hosts:list", () => hosts.list());
  ipcMain.handle("hosts:select", (_event, value) => {
    const { expectedId, id } = z.object({ expectedId: z.string(), id: z.string() }).strict().parse(value);
    const next = hosts.select(expectedId, id); closePreviewForwards(); return next;
  });
  ipcMain.handle("host:call", async (event, value) => {
    const { hostId, channel, args } = z.object({ hostId: z.string(), channel: z.string(), args: z.array(z.unknown()) }).strict().parse(value);
    hosts.assertSelected(hostId);
    const host = hosts.selected();
    if (host.kind === "ssh") {
      if (channel === "host:status") return hosts.status(hostId);
      if (["config:open-in-editor", "config:reveal"].includes(channel)) { await shell.openExternal(buildEditorDeepLink("ssh", "zed", host.sshHost, host.configPath)); return null; }
      if (channel === "shell:open-path") { const target = z.string().startsWith("/").parse(args[0]); await shell.openExternal(buildEditorDeepLink("ssh", "zed", host.sshHost, target)); return ""; }
      if (["shell:open-with", "repository:pick", "fs:pick-file", "fs:pick-folder", "skills:pick-root", "management:open-terminal"].includes(channel)) throw new Error("Use the selected machine's path picker or an SSH-capable editor");
      if (channel === "tasks:preview") {
        const url = await hosts.request<string>(hostId, channel, args);
        hosts.assertSelected(hostId);
        return forwardPreview(host, url);
      }
      if (!channel.startsWith("keybindings:") && channel !== "editors:detect") return hosts.request(hostId, channel, args);
    }
    process.env.REMOTE_AGENT_CONFIG = localFile();
    if (["host:status", "tasks:list", "tasks:activity", "tasks:control", "tasks:answer", "tasks:instruct", "tasks:resolve", "tasks:preview", "fs:list", "repository:validate"].includes(channel)) {
      try { return await desktopOperation(localFile(), { method: channel, args }); }
      catch (error) { if (channel === "host:status") return { connected: true, serverAvailable: false, detail: error instanceof Error ? error.message : String(error) }; throw error; }
    }
    const handler = handlers.get(channel);
    if (!handler) throw new Error("Unsupported desktop action");
    return handler(event, ...args);
  });
}
