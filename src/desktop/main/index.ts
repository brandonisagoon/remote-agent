import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { watch } from "chokidar";
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";

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
  installCli,
  installService,
  openInTerminal,
  installUpdate,
  restartService,
  serviceStatus,
} from "../../management/service.ts";
import { runChecks } from "../../management/checks.ts";
import { listProviderModels } from "./provider-models.ts";
import { tunnelInfo } from "./tunnel-info.ts";
import type { DesktopApi, Keybindings, SessionSummary } from "../shared.ts";

let mainWindow: BrowserWindow | null = null;
let stopWatching: (() => Promise<void>) | null = null;
let stopWatchingKeybindings: (() => Promise<void>) | null = null;
let ipcRegistered = false;

// Keep the traffic lights vertically centered in the renderer's 48px header
// (h-12), which scales with page zoom while the native buttons do not.
const HEADER_HEIGHT = 48;
const TRAFFIC_LIGHT_HEIGHT = 16;
const TRAFFIC_LIGHT_X = 16;

function trafficLightPositionForZoom(zoom: number): { x: number; y: number } {
  return {
    x: TRAFFIC_LIGHT_X * zoom,
    y: (HEADER_HEIGHT * zoom - TRAFFIC_LIGHT_HEIGHT) / 2,
  };
}

const DEFAULT_KEYBINDINGS: Keybindings = {
  "toggle-sidebar": "Mod+B",
  "back": "Mod+[",
  "forward": "Mod+]",
  "save": "Mod+S",
  "revert": "Escape",
  "toggle-secrets": "Mod+Shift+.",
  "prev-item": "Mod+Alt+ArrowUp",
  "next-item": "Mod+Alt+ArrowDown",
  // Modifier prefix: the sidebar item's number 1-9 is appended (Mod+1..Mod+9).
  "jump-item": "Mod",
  "add-repository": "Mod+O",
};

function keybindingsPath(configFile: string): string {
  return path.join(path.dirname(configFile), "keybindings.json");
}

function ensureKeybindings(file: string): void {
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify(DEFAULT_KEYBINDINGS, null, 2)}\n`, { mode: 0o644 });
    return;
  }
  // Additive migration: newly introduced actions get their defaults appended
  // without touching the user's existing chords.
  const current = readKeybindings(file);
  const missing = Object.entries(DEFAULT_KEYBINDINGS).filter(([action]) => !(action in current));
  if (missing.length > 0) {
    writeFileSync(file, `${JSON.stringify({ ...current, ...Object.fromEntries(missing) }, null, 2)}\n`, { mode: 0o644 });
  }
}

function readKeybindings(file: string): Keybindings {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "string" && value.length > 0),
    ) as Keybindings;
  } catch {
    return {};
  }
}

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
  ipcMain.handle("keybindings:get", () => readKeybindings(keybindingsPath(file)));
  ipcMain.handle("tunnel:info", (_event, name: string) => tunnelInfo(name));
  ipcMain.handle("provider:models", (_event, providerId: string) => {
    const document = readConfigDocument(file);
    const agents = document.valid ? document.value.providers : {};
    return listProviderModels(providerId, agents);
  });
  ipcMain.on("window:sync-traffic-lights", (event) => {
    if (process.platform !== "darwin") return;
    const window = BrowserWindow.fromWebContents(event.sender);
    window?.setWindowButtonPosition(trafficLightPositionForZoom(event.sender.getZoomFactor()));
  });
  ipcMain.handle("keybindings:open-in-editor", async () => {
    const error = await shell.openPath(keybindingsPath(file));
    return error || null;
  });
  ipcMain.handle("sessions:list", (_event, repositoryId?: string) => listSessions(repositoryId));
  const actions: Record<string, () => Promise<unknown>> = {
    status: serviceStatus,
    doctor,
    install: installService,
    "install-cli": installCli,
    "check-update": checkForUpdates,
    update: installUpdate,
    restart: restartService,
  };
  ipcMain.handle("repository:pick", async () => {
    const result = await dialog.showOpenDialog({
      title: "Add Repository",
      buttonLabel: "Add Repository",
      properties: ["openDirectory"],
    });
    const root = result.filePaths[0];
    if (result.canceled || !root) return null;
    if (!existsSync(path.join(root, ".git"))) return { error: "not-a-repository" as const };
    return { repository: { root, name: path.basename(root) } };
  });
  ipcMain.handle("management:checks", () => runChecks());
  ipcMain.handle("management:open-terminal", (_event, commandLine: string) => openInTerminal(commandLine));
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
  await stopWatchingKeybindings?.();

  mainWindow = new BrowserWindow({
    width: 1120,
    height: 920,
    minWidth: 1040,
    minHeight: 700,
    titleBarStyle: "hidden",
    trafficLightPosition: trafficLightPositionForZoom(1),
    // Native sidebar translucency: an NSVisualEffectView behind the window;
    // the renderer keeps the sidebar region transparent so it shows through.
    vibrancy: "sidebar",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Renderer links (target=_blank) open in the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  stopWatching = watchConfigDocument(file, (document) => {
    mainWindow?.webContents.send("config:changed", document);
  });

  const bindingsFile = keybindingsPath(file);
  ensureKeybindings(bindingsFile);
  buildApplicationMenu(bindingsFile);
  const keybindingsWatcher = watch(bindingsFile, { ignoreInitial: true });
  keybindingsWatcher.on("all", () => {
    mainWindow?.webContents.send("keybindings:changed", readKeybindings(bindingsFile));
    buildApplicationMenu(bindingsFile);
  });
  stopWatchingKeybindings = () => keybindingsWatcher.close();

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    await mainWindow.loadFile(path.join(import.meta.dirname, "../renderer/index.html"));
  }
}

app.setName("Remote Agent");

/** Mirrors the sidebar's add controls in the macOS File menu. Accelerators
    come from keybindings.json so the menu stays in sync with in-app hotkeys. */
function buildApplicationMenu(bindingsFile: string): void {
  const bindings = readKeybindings(bindingsFile);
  const send = (payload: unknown) => mainWindow?.webContents.send("menu:action", payload);
  const accelerator = (chord: string | undefined) => chord?.replace("Mod", "CmdOrCtrl");
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    {
      label: "File",
      submenu: [
        {
          label: "Add Repository…",
          accelerator: accelerator(bindings["add-repository"]) ?? "CmdOrCtrl+O",
          click: () => send({ action: "add-repository" }),
        },
        {
          label: "Add Connection",
          submenu: [
            { label: "Linear", click: () => send({ action: "add-connection" }) },
            { label: "Slack", enabled: false },
            { label: "GitHub", enabled: false },
          ],
        },
        {
          label: "Add Provider",
          submenu: [
            { label: "Codex", click: () => send({ action: "add-provider", providerId: "codex" }) },
            { label: "Claude Code", click: () => send({ action: "add-provider", providerId: "claude" }) },
          ],
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ]));
}

app.whenReady().then(async () => {
  // Dev runs the stock Electron binary; give the Dock our name and icon.
  // (The packaged app gets both from the bundle.)
  if (!app.isPackaged && process.platform === "darwin") {
    try {
      app.dock?.setIcon(path.join(app.getAppPath(), "build", "icon.png"));
    } catch {
      // Icon is cosmetic; never block startup on it.
    }
  }
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
  void stopWatchingKeybindings?.();
});
