import type {
  SessionConfigOption,
  SessionNotification,
} from "@agentclientprotocol/sdk";

export type AgentRuntimeStatus =
  | "provisioning"
  | "idle"
  | "active"
  | "error"
  | "closed";

export interface AgentRuntimeSession {
  id: string;
  scopeKey: string;
  acpxRecordId: string | null;
  acpxSessionId: string | null;
  agentSessionId: string | null;
  agent: "codex" | "claude";
  cwd: string;
  name: string | null;
  worktreePath: string | null;
  executionTarget: string | null;
  status: AgentRuntimeStatus;
  configOptions: SessionConfigOption[];
  usage: AgentRuntimeUsage | null;
  closedAt: Date | null;
}

export interface AgentRuntimeUsage {
  used: number;
  size: number;
  cost?: { amount: number; currency: string };
}

export interface AgentRuntimeMessage {
  role: "user" | "agent";
  text: string;
}

export type AgentRuntimeUpdateEvent = {
  kind: "update";
  id: string;
  sessionId: string;
  requestId: string;
  createdAt: number;
  update: SessionNotification["update"];
};

export type AgentRuntimeLifecycleEvent = {
  kind: "turn";
  id: string;
  sessionId: string;
  requestId: string;
  createdAt: number;
  sequence?: number;
  phase: "started" | "completed" | "failed" | "cancelled";
  error?: string;
};

export type AgentRuntimeEvent =
  | AgentRuntimeUpdateEvent
  | AgentRuntimeLifecycleEvent;

export interface AgentRuntimeTurnResult {
  status: "completed" | "cancelled" | "failed";
  stopReason?: string;
  error?: string;
}

export interface AgentRuntimeTurn {
  requestId: string;
  events: AsyncIterable<AgentRuntimeEvent>;
  result: Promise<AgentRuntimeTurnResult>;
  cancel(reason?: string): Promise<void>;
}

export interface EnsureAgentSessionInput {
  sessionKey: string;
  agent: "codex" | "claude";
  cwd: string;
  name?: string;
  worktreePath?: string;
  executionTarget?: string;
  model?: string;
  systemPrompt?: string;
  agentEnv?: Record<string, string>;
}

export interface AgentSessionRuntime {
  ensureSession(input: EnsureAgentSessionInput): Promise<AgentRuntimeSession>;
  getSession(sessionId: string): Promise<AgentRuntimeSession | null>;
  listSessions(input?: {
    cwd?: string;
    includeClosed?: boolean;
  }): Promise<AgentRuntimeSession[]>;
  history(sessionId: string): Promise<AgentRuntimeMessage[]>;
  startTurn(input: {
    sessionId: string;
    text: string;
    requestId?: string;
    mode?: "prompt" | "steer";
    signal?: AbortSignal;
  }): AgentRuntimeTurn;
  enqueue(input: {
    sessionId: string;
    text: string;
    requestId?: string;
  }): Promise<string>;
  setMode(sessionId: string, mode: string): Promise<void>;
  setConfigOption(
    sessionId: string,
    key: string,
    value: string,
  ): Promise<SessionConfigOption[]>;
  switchAgent(
    sessionId: string,
    agent: "codex" | "claude",
  ): Promise<AgentRuntimeSession>;
  cancel(sessionId: string, reason?: string): Promise<void>;
  close(sessionId: string, reason: string): Promise<void>;
  output(sessionId: string): Promise<string | null>;
  subscribe(
    sessionId: string,
    listener: (event: AgentRuntimeEvent) => void | Promise<void>,
  ): () => void;
  subscribeAll(
    listener: (event: AgentRuntimeEvent) => void | Promise<void>,
  ): () => void;
  shutdown(): Promise<void>;
}
