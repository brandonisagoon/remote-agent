import { contextBridge, ipcRenderer } from "electron";

import type { DesktopApi } from "../shared.ts";

const api: DesktopApi = {
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
    run: (action) => ipcRenderer.invoke("management:run", action),
  },
};

contextBridge.exposeInMainWorld("remoteAgent", api);
