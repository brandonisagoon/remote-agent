export const BbThreadStatuses = [
  "starting",
  "active",
  "idle",
  "stopping",
  "error",
] as const;

export type BbThreadStatus = (typeof BbThreadStatuses)[number];

export type BbProviderId = "codex" | "claude-code";

export type BbPermissionMode = "accept-edits" | "auto" | "full";
export type BbServiceTier = "default" | "fast";

export type BbReasoningLevel =
  "none" | "low" | "medium" | "high" | "xhigh" | "ultracode" | "max" | "ultra";

export interface BbConfig {
  baseUrl: string;
  projectId: string;
  hostIds: Record<string, string>;
}

export interface BbThread {
  id: string;
  projectId: string;
  environmentId: string | null;
  hostId: string | null;
  providerId: string;
  title: string | null;
  status: BbThreadStatus;
  parentThreadId: string | null;
  archivedAt: number | null;
  createdAt?: number;
  visibility?: "visible" | "hidden";
}

export interface BbProvider {
  id: string;
  displayName: string;
  available: boolean;
  supportedPermissionModes: BbPermissionMode[];
}

export interface BbModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  supportedReasoningEfforts: Array<{
    reasoningEffort: BbReasoningLevel;
    description: string;
  }>;
  defaultReasoningEffort: BbReasoningLevel;
  isDefault: boolean;
}

export interface BbExecutionOptions {
  model: string;
  reasoningLevel: BbReasoningLevel;
  permissionMode: BbPermissionMode;
  serviceTier: BbServiceTier;
}

export interface BbEvent {
  id: string;
  threadId: string;
  seq: number;
  createdAt: number;
  type: string;
  scope: { kind: "thread" } | { kind: "turn"; turnId: string };
  data: unknown;
}

export interface BbEnvironment {
  id: string;
  projectId: string;
  hostId: string;
  path: string | null;
  branchName: string | null;
}

export interface BbMachine {
  id: string;
  name: string;
  status: string;
}

export interface BbPendingInteraction {
  id: string;
  threadId: string;
  status: "pending" | "interrupted" | "resolving" | "resolved";
  payload: unknown;
}

export interface BbSendMessageInput {
  threadId: string;
  message: string;
  mode?: "auto" | "start" | "steer" | "queue-if-active" | "steer-if-active";
  model?: string;
  reasoningLevel?: BbReasoningLevel;
  permissionMode?: BbPermissionMode;
  serviceTier?: BbServiceTier;
}

export interface BbSpawnThreadInput {
  projectId: string;
  prompt: string;
  promptVisibility?: "agent-only";
  worktreePath: string;
  providerId: BbProviderId;
  model?: string;
  hostId?: string;
  parentThreadId?: string;
  title?: string;
  permissionMode?: BbPermissionMode;
  reasoningLevel?: BbReasoningLevel;
  serviceTier?: BbServiceTier;
  visibility?: "visible" | "hidden";
}

export interface BbStreamEventsInput {
  threadId: string;
  afterSeq?: number;
  signal?: AbortSignal;
}

/** App-owned seam around bb's public SDK. Business services depend on this
 * interface so tests never need a running bb server. */
export interface BbClient {
  getThread(threadId: string): Promise<BbThread | null>;
  /** Ask connected bb app windows to present a thread. */
  openThread(threadId: string): Promise<number>;
  getEnvironment(environmentId: string): Promise<BbEnvironment | null>;
  getThreadExecutionOptions(
    threadId: string,
  ): Promise<BbExecutionOptions | null>;
  getThreadOutput(threadId: string): Promise<string | null>;
  listThreads(input?: {
    projectId?: string;
    archived?: boolean;
    includeHidden?: boolean;
  }): Promise<BbThread[]>;
  listProviders(input?: {
    environmentId?: string;
    hostId?: string;
  }): Promise<BbProvider[]>;
  listModels(input: {
    providerId: BbProviderId;
    environmentId?: string;
    hostId?: string;
  }): Promise<BbModel[]>;
  listEvents(input: {
    threadId: string;
    afterSeq?: number;
  }): Promise<BbEvent[]>;
  listInteractions(threadId: string): Promise<BbPendingInteraction[]>;
  resolveInteraction(input: {
    threadId: string;
    interactionId: string;
    resolution: unknown;
  }): Promise<void>;
  sendMessage(input: BbSendMessageInput): Promise<void>;
  spawnThread(input: BbSpawnThreadInput): Promise<BbThread>;
  updateThreadExecutionOptions(input: {
    threadId: string;
    model?: string;
    reasoningLevel?: BbReasoningLevel;
  }): Promise<void>;
  stopThread(threadId: string): Promise<void>;
  archiveThread(threadId: string): Promise<void>;
  listMachines(): Promise<BbMachine[]>;
  streamEvents(input: BbStreamEventsInput): AsyncIterable<BbEvent>;
}
