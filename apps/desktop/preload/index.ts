import { contextBridge, ipcRenderer } from "electron";

import type { DesktopHosts } from "../../../lib/desktop-host.ts";

import type { DesktopApi, HostDesktopApi } from "../shared.ts";

const initialHosts: Promise<DesktopHosts> = ipcRenderer.invoke("hosts:list");
const clientInvoke = async (channel: string, ...args: unknown[]) =>
  ipcRenderer.invoke("host:call", { hostId: (await initialHosts).hosts[0]!.id, channel, args });

function forHost(hostId: string): HostDesktopApi {
  const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke("host:call", { hostId, channel, args });
  return {
    status: () => invoke("host:status"),
    tasks: {
      list: () => invoke("tasks:list"),
      activity: (id) => invoke("tasks:activity", id),
      control: (id, action) => invoke("tasks:control", id, action),
      answer: (id, questionId, answer) => invoke("tasks:answer", id, questionId, answer),
      instruct: (id, requestKey, text) => invoke("tasks:instruct", id, requestKey, text),
      resolve: (id, instructionId, action, reason) => invoke("tasks:resolve", id, instructionId, action, reason),
      preview: (id, resourceId) => invoke("tasks:preview", id, resourceId),
    },
    tunnel: {
      info: (name) => invoke("tunnel:info", name),
    },
    provider: {
      models: (providerId) => invoke("provider:models", providerId),
    },
    config: {
      path: () => invoke("config:path"),
      get: () => invoke("config:get"),
      save: (input) => invoke("config:save", input),
      onChange: (listener) => {
        const handler = (_event: Electron.IpcRendererEvent, changedHost: string, document: Parameters<typeof listener>[0]) =>
          { if (changedHost === hostId) listener(document); };
        ipcRenderer.on("config:changed", handler);
        return () => ipcRenderer.off("config:changed", handler);
      },
      openInEditor: () => invoke("config:open-in-editor"),
      reveal: () => invoke("config:reveal"),
    },
    sessions: {
      list: (repositoryId) => invoke("sessions:list", repositoryId),
      repositoryReference: (repositoryId) => invoke("sessions:repository-reference", repositoryId),
      forHost: (hostId, repository) => ipcRenderer.invoke("sessions:for-host", { hostId, repository }),
    },
    repository: {
      validate: (root) => invoke("repository:validate", root),
      pick: () => invoke("repository:pick"),
    },
    fs: {
      list: (directory, kind) => invoke("fs:list", directory, kind),
      pickFolder: (title, defaultPath) => invoke("fs:pick-folder", title, defaultPath),
      pickFile: (title, defaultPath) => invoke("fs:pick-file", title, defaultPath),
    },
    skills: {
      check: (root, skillsRoot) => invoke("skills:check", root, skillsRoot),
      pickRoot: (defaultPath) => invoke("skills:pick-root", defaultPath),
    },
    repoConfigs: {
      get: () => invoke("repo-configs:get"),
      save: (input) => invoke("repo-config:save", input),
      onChange: (callback) => {
        const listener = (_event: unknown, changedHost: string, documents: unknown) => { if (changedHost === hostId) callback(documents as never); };
        ipcRenderer.on("repo-configs:changed", listener);
        return () => ipcRenderer.removeListener("repo-configs:changed", listener);
      },
    },
    shell: {
      openPath: (target) => invoke("shell:open-path", target),
      openWith: (appPath, target) => invoke("shell:open-with", appPath, target),
    },
    management: {
      checks: () => invoke("management:checks"),
      openTerminal: (commandLine) => invoke("management:open-terminal", commandLine),
      run: (action) => invoke("management:run", action),
    },
  };
}

const api: DesktopApi = {
  forHost,
  hosts: { list: () => ipcRenderer.invoke("hosts:list") },
  window: {
    syncTrafficLights: () => ipcRenderer.send("window:sync-traffic-lights"),
  },
  keybindings: {
    get: () => clientInvoke("keybindings:get"),
    onChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, bindings: Parameters<typeof listener>[0]) =>
        listener(bindings);
      ipcRenderer.on("keybindings:changed", handler);
      return () => ipcRenderer.off("keybindings:changed", handler);
    },
    openInEditor: () => clientInvoke("keybindings:open-in-editor"),
  },
  menu: {
    onAction: (callback) => {
      const listener = (_event: unknown, payload: unknown) => callback(payload as never);
      ipcRenderer.on("menu:action", listener);
      return () => ipcRenderer.removeListener("menu:action", listener);
    },
  },
  editors: {
    detect: () => clientInvoke("editors:detect"),
  },
};
contextBridge.exposeInMainWorld("remoteAgent", api);
