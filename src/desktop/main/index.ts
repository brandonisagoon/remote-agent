import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";

import example from "../../../remote-agent.config.example.json";
import schema from "../../../remote-agent.config.schema.json";
import {
  readConfigDocument,
  watchConfigDocument,
  writeConfigDocument,
} from "../../lib/config-file.ts";
import {
  checkForUpdates,
  doctor,
  installService,
  installUpdate,
  restartService,
  serviceStatus,
} from "../../management/service.ts";
import type { DesktopApi, SessionSummary } from "../shared.ts";

let mainWindow: BrowserWindow | null = null;
let stopWatching: (() => Promise<void>) | null = null;
let ipcRegistered = false;

function desktopConfigPath(): string {
  const explicit = process.env.REMOTE_AGENT_CONFIG?.trim();
  if (explicit) return path.resolve(explicit);
  const development = path.resolve(process.cwd(), "remote-agent.config.json");
  if (!app.isPackaged && existsSync(development)) return development;
  return path.join(app.getPath("userData"), "remote-agent.config.json");
}

function ensureConfig(file: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const schemaFile = path.join(path.dirname(file), "remote-agent.config.schema.json");
  if (!existsSync(schemaFile)) {
    writeFileSync(schemaFile, `${JSON.stringify(schema, null, 2)}\n`, { mode: 0o644 });
  }
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(example, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  }
}

async function listSessions(repositoryId?: string): Promise<SessionSummary[]> {
  const document = readConfigDocument(desktopConfigPath());
  if (!document.valid) throw new Error(document.error);
  const { host, port } = document.value.machine.server.listen;
  const query = new URLSearchParams({ includeClosed: "true" });
  if (repositoryId) query.set("repositoryId", repositoryId);
  const response = await fetch(`http://${host}:${port}/api/sessions?${query}`, {
    headers: { authorization: `Bearer ${document.value.machine.server.apiKey}` },
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`session API returned ${response.status}`);
  const body = await response.json() as { sessions: Array<Record<string, any>> };
  return body.sessions.map((session) => ({
    id: String(session.id),
    repositoryId: String(session.repositoryId),
    machineId: String(session.machineId),
    name: typeof session.name === "string" ? session.name : null,
    status: String(session.status),
    role: typeof session.role === "string" ? session.role : null,
    agentCommand: String(session.agentCommand),
    cwd: String(session.cwd),
    worktreePath: typeof session.worktreePath === "string" ? session.worktreePath : null,
    updatedAt: String(session.updatedAt),
    tags: Array.isArray(session.tags) ? session.tags : [],
    resourceLinks: Array.isArray(session.resourceLinks) ? session.resourceLinks : [],
  }));
}

function registerIpc(file: string): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle("config:get", () => readConfigDocument(file));
  ipcMain.handle("config:save", (_event, input: { expectedRevision: string; value: unknown }) =>
    writeConfigDocument({ file, ...input }));
  ipcMain.handle("config:open-in-editor", async () => {
    const error = await shell.openPath(file);
    return error || null;
  });
  ipcMain.handle("config:reveal", () => shell.showItemInFolder(file));
  ipcMain.handle("sessions:list", (_event, repositoryId?: string) => listSessions(repositoryId));
  const actions: Record<string, () => Promise<unknown>> = {
    status: serviceStatus,
    doctor,
    install: installService,
    "check-update": checkForUpdates,
    update: installUpdate,
    restart: restartService,
  };
  ipcMain.handle("management:run", (_event, action: keyof typeof actions) => {
    const run = actions[action];
    if (!run) throw new Error(`unknown management action: ${action}`);
    return run();
  });
}

async function createWindow(): Promise<void> {
  const file = desktopConfigPath();
  ensureConfig(file);
  process.env.REMOTE_AGENT_CONFIG = file;
  registerIpc(file);

  await stopWatching?.();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    titleBarStyle: "hiddenInset",
    backgroundColor: "#0a0a0b",
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  stopWatching = watchConfigDocument(file, (document) => {
    mainWindow?.webContents.send("config:changed", document);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  void stopWatching?.();
});
