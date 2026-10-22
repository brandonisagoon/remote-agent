import type { ConfigDocument } from "../../lib/config-file.ts";
import type { RepoConfigDocument } from "../../lib/config-file.ts";
import type { CheckResult } from "../../management/checks.ts";
import type { SkillsCheck } from "../../lib/skills/check.ts";
import type { DetectedEditor } from "./main/editor-detect.ts";
import type { ManagementResult } from "../../management/service.ts";
import type { DesktopHosts, DesktopHostStatus, DesktopTask, DesktopTaskActivity } from "../../lib/desktop-host.ts";
import type { DesktopRepositoryReference, MachineSessions, SessionSummary } from "../../lib/desktop-sessions.ts";
export type { SessionSummary } from "../../lib/desktop-sessions.ts";

/** Action id → TanStack Hotkeys chord string (e.g. "Mod+B"). */
export type Keybindings = Record<string, string>;

export interface DesktopApi {
  forHost(hostId: string): HostDesktopApi;
  hosts: {
    list(): Promise<DesktopHosts>;
  };
  window: { syncTrafficLights(): void };
  keybindings: {
    get(): Promise<Keybindings>;
    onChange(listener: (bindings: Keybindings) => void): () => void;
    openInEditor(): Promise<string | null>;
  };
  menu: {
    onAction(callback: (payload:
      | { action: "add-repository" }
      | { action: "add-connection" }
      | { action: "add-provider"; providerId: "codex" | "claude" }
    ) => void): () => void;
  };
  editors: { detect(): Promise<DetectedEditor[]> };
}

export interface HostDesktopApi {
  status(): Promise<DesktopHostStatus>;
  tasks: {
    list(): Promise<DesktopTask[]>;
    activity(id: string): Promise<DesktopTaskActivity>;
    control(id: string, action: "pause" | "resume" | "close"): Promise<unknown>;
    answer(id: string, questionId: string, answer: string): Promise<unknown>;
    instruct(id: string, requestKey: string, text: string): Promise<unknown>;
    resolve(id: string, instructionId: string, action: "acknowledge" | "cancel" | "retry", reason: string): Promise<unknown>;
    preview(id: string, resourceId: string): Promise<string>;
  };
  tunnel: {
    /** Cloudflare tunnel UUID for a tunnel name, or null with a reason. */
    info(name: string): Promise<{ tunnelId: string | null; reason?: "cli-missing" | "not-found" }>;
  };
  provider: {
    /** Model ids advertised by the installed provider binary (with fallback). */
    models(providerId: string): Promise<string[]>;
  };
  config: {
    path(): Promise<string>;
    get(): Promise<ConfigDocument>;
    save(input: { expectedRevision: string; value: unknown }): Promise<ConfigDocument>;
    onChange(listener: (document: ConfigDocument) => void): () => void;
    openInEditor(): Promise<string | null>;
    reveal(): Promise<void>;
  };
  sessions: {
    list(repositoryId?: string): Promise<SessionSummary[]>;
    repositoryReference(repositoryId: string): Promise<DesktopRepositoryReference>;
    forHost(hostId: string, repository: DesktopRepositoryReference): Promise<MachineSessions>;
  };
  repository: {
    validate(root: string): Promise<{ repository: { root: string; name: string } } | { error: "not-a-repository" }>;
    pick(): Promise<{ repository: { root: string; name: string } } | { error: "not-a-repository" } | null>;
  };
  fs: {
    list(directory: string, kind: "file" | "folder"): Promise<{ path: string; parent: string; entries: Array<{ name: string; path: string; directory: boolean }> }>;
    /** Native folder picker; returns the chosen absolute path or null. */
    pickFolder(title: string, defaultPath?: string): Promise<string | null>;
    /** Native file picker; returns the chosen absolute path or null. */
    pickFile(title: string, defaultPath?: string): Promise<string | null>;
  };
  repoConfigs: {
    /** Every repository's committed config document, keyed by repo id. */
    get(): Promise<Record<string, RepoConfigDocument & { root: string }>>;
    /** Revision-guarded save into the repo's working tree. */
    save(input: { id: string; expectedRevision: string; value: unknown }): Promise<RepoConfigDocument>;
    /** Push stream fed by the main-process file watchers. */
    onChange(callback: (documents: Record<string, RepoConfigDocument & { root: string }>) => void): () => void;
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
