import { contextBridge, ipcRenderer } from "electron";

import type { DesktopApi } from "../shared.ts";

const api: DesktopApi = {
  tunnel: {
    info: (name) => ipcRenderer.invoke("tunnel:info", name),
  },
  provider: {
    models: (providerId) => ipcRenderer.invoke("provider:models", providerId),
  },
  window: {
    syncTrafficLights: () => ipcRenderer.send("window:sync-traffic-lights"),
  },
  keybindings: {
    get: () => ipcRenderer.invoke("keybindings:get"),
    onChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, bindings: Parameters<typeof listener>[0]) =>
        listener(bindings);
      ipcRenderer.on("keybindings:changed", handler);
      return () => ipcRenderer.off("keybindings:changed", handler);
    },
    openInEditor: () => ipcRenderer.invoke("keybindings:open-in-editor"),
  },
  config: {
    get: () => ipcRenderer.invoke("config:get"),
    save: (input) => ipcRenderer.invoke("config:save", input),
    onChange: (listener) => {
      const handler = (_event: Electron.IpcRendererEvent, document: Parameters<typeof listener>[0]) =>
        listener(document);
      ipcRenderer.on("config:changed", handler);
      return () => ipcRenderer.off("config:changed", handler);
    },
    openInEditor: () => ipcRenderer.invoke("config:open-in-editor"),
    reveal: () => ipcRenderer.invoke("config:reveal"),
  },
  sessions: {
    list: (repositoryId) => ipcRenderer.invoke("sessions:list", repositoryId),
  },
  management: {
    checks: () => ipcRenderer.invoke("management:checks"),
    run: (action) => ipcRenderer.invoke("management:run", action),
  },
};

contextBridge.exposeInMainWorld("remoteAgent", api);
