import { contextBridge, ipcRenderer } from "electron";

import type { DesktopHosts } from "../../../lib/desktop-host.ts";

import type { DesktopApi } from "../shared.ts";

const initialHosts: Promise<DesktopHosts> = ipcRenderer.invoke("hosts:list");
const invoke = async (channel: string, ...args: unknown[]) => {
  const hosts = await initialHosts;
  return ipcRenderer.invoke("host:call", { hostId: hosts.activeId, channel, args });
};
const api: DesktopApi = {
  hosts: {
    list: () => ipcRenderer.invoke("hosts:list"),
    select: async (id) => ipcRenderer.invoke("hosts:select", { expectedId: (await initialHosts).activeId, id }),
    status: () => invoke("host:status"),
  },
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
  window: {
    syncTrafficLights: () => ipcRenderer.send("window:sync-traffic-lights"),
  },
  keybindings: {
    get: () => invoke("keybindings:get"),
    onChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, bindings: Parameters<typeof listener>[0]) =>
        listener(bindings);
      ipcRenderer.on("keybindings:changed", handler);
      return () => ipcRenderer.off("keybindings:changed", handler);
    },
    openInEditor: () => invoke("keybindings:open-in-editor"),
  },
  config: {
    path: () => invoke("config:path"),
    get: () => invoke("config:get"),
    save: (input) => invoke("config:save", input),
    onChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, document: Parameters<typeof listener>[0]) =>
        listener(document);
      ipcRenderer.on("config:changed", handler);
      return () => ipcRenderer.off("config:changed", handler);
    },
    openInEditor: () => invoke("config:open-in-editor"),
    reveal: () => invoke("config:reveal"),
  },
  sessions: {
    list: (repositoryId) => invoke("sessions:list", repositoryId),
    repositoryReference: (repositoryId) => invoke("sessions:repository-reference", repositoryId),
    forHost: async (hostId, repository) => ipcRenderer.invoke("sessions:for-host", { expectedId: (await initialHosts).activeId, hostId, repository }),
  },
  menu: {
    onAction: (callback) => {
      const listener = (_event: unknown, payload: unknown) => callback(payload as never);
      ipcRenderer.on("menu:action", listener);
      return () => ipcRenderer.removeListener("menu:action", listener);
    },
  },
  repository: {
    validate: (root) => invoke("repository:validate", root),
    pick: () => invoke("repository:pick"),
  },
  editors: {
    detect: () => invoke("editors:detect"),
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
      const listener = (_event: unknown, documents: unknown) => callback(documents as never);
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

contextBridge.exposeInMainWorld("remoteAgent", api);
