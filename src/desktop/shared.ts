import type { ConfigDocument } from "../lib/config-file.ts";
import type { CheckResult } from "../management/checks.ts";
import type { SkillsCheck } from "../lib/skills/check.ts";
import type { DetectedEditor } from "./main/editor-detect.ts";
import type { ManagementResult } from "../management/service.ts";

export interface SessionSummary {
  id: string;
  repositoryId: string;
  machineId: string;
  name: string | null;
  status: string;
  role: string | null;
  agentCommand: string;
  cwd: string;
  worktreePath: string | null;
  updatedAt: string;
  labels: Array<{ key: string; value: string; source: string }>;
  resourceLinks: Array<{
    provider: string;
    connectionId: string;
    resourceType: string;
    externalId: string;
    relationship: string;
  }>;
}

/** Action id → TanStack Hotkeys chord string (e.g. "Mod+B"). */
export type Keybindings = Record<string, string>;

export interface DesktopApi {
  tunnel: {
    /** Cloudflare tunnel UUID for a tunnel name, or null with a reason. */
    info(name: string): Promise<{ tunnelId: string | null; reason?: "cli-missing" | "not-found" }>;
  };
  provider: {
    /** Model ids advertised by the installed provider binary (with fallback). */
    models(providerId: string): Promise<string[]>;
  };
  window: {
    /** Re-center the native traffic lights against the zoom-scaled header. */
    syncTrafficLights(): void;
  };
  keybindings: {
    get(): Promise<Keybindings>;
    onChange(listener: (bindings: Keybindings) => void): () => void;
    openInEditor(): Promise<string | null>;
  };
  config: {
    path(): Promise<string>;
    get(): Promise<ConfigDocument>;
    save(input: { expectedRevision: string; value: unknown }): Promise<ConfigDocument>;
    onChange(listener: (document: ConfigDocument) => void): () => void;
    path(): Promise<string>;
    openInEditor(): Promise<string | null>;
    reveal(): Promise<void>;
  };
  sessions: {
    list(repositoryId?: string): Promise<SessionSummary[]>;
  };
  menu: {
    onAction(
      callback: (
        payload:
          | { action: "add-repository" }
          | { action: "add-connection" }
          | { action: "add-provider"; providerId: "codex" | "claude" },
      ) => void,
    ): () => void;
  };
  repository: {
    pick(): Promise<{ repository: { root: string; name: string } } | { error: "not-a-repository" } | null>;
  };
  editors: {
    detect(): Promise<DetectedEditor[]>;
  };
  skills: {
    check(root: string, skillsRoot: string): Promise<SkillsCheck>;
    pickRoot(defaultPath: string): Promise<string | null>;
  };
  shell: {
    openPath(target: string): Promise<string>;
    openWith(appPath: string, target: string): Promise<void>;
  };
  management: {
    checks(): Promise<CheckResult[]>;
    openTerminal(commandLine: string): Promise<ManagementResult>;
    run(action: "status" | "doctor" | "install" | "install-cli" | "check-update" | "update" | "restart"): Promise<ManagementResult>;
  };
}
