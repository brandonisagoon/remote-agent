import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionRequest,
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
  repositoryId: string;
  machineId: string;
  role: string | null;
  lifecycle: string | null;
  workflowId: string | null;
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
  output?: string;
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
  repositoryId?: string;
  machineId?: string;
  role?: string;
  lifecycle?: "one-shot" | "persistent";
  /** Launch provenance: the configured workflow that started this session. */
  workflowId?: string;
  labels?: Record<string, string[]>;
  relations?: Array<{
    relationship: string;
    targetSessionId: string;
  }>;
  resourceLinks?: Array<{
    provider: string;
    connectionId: string;
    resourceType: string;
    externalId: string;
    relationship: string;
  }>;
}

export interface AgentSessionRuntime {
  ensureSession(input: EnsureAgentSessionInput): Promise<AgentRuntimeSession>;
  getSession(sessionId: string): Promise<AgentRuntimeSession | null>;
  /** Explicit recovery only: prove the provider writer has stopped before
   * clearing stale active state. Never infers an instruction's outcome. */
  reconcileInterruptedSession?(sessionId: string): Promise<AgentRuntimeSession>;
  /** Process-local observation; absence of owned work never proves idle. */
  observeSessionActivity?(sessionId: string): { state: "executing" | "queued" | "unknown"; observedAt: number; requestId?: string };
  listSessions(input?: {
    cwd?: string;
    repositoryId?: string;
    includeClosed?: boolean;
  }): Promise<AgentRuntimeSession[]>;
  history(sessionId: string): Promise<AgentRuntimeMessage[]>;
  startTurn(input: {
    sessionId: string;
    text: string;
    requestId?: string;
    mode?: "prompt" | "steer";
    signal?: AbortSignal;
    /** Claim a durable instruction only after a provider slot is available. */
    beforeStart?: () => Promise<boolean>;
    /** Answers the agent's planning questions (ACP elicitation) for this
        turn. Absent = headless; acpx resolves them non-interactively. */
    onElicitation?: AgentElicitationHandler;
  }): AgentRuntimeTurn;
  enqueue(input: {
    sessionId: string;
    text: string;
    requestId?: string;
    sourceMessageId?: string;
  }): Promise<string>;
  /** Optional native active-turn control. Unsupported adapters must say so. */
  steer?(input: { sessionId: string; requestId: string; targetRequestId: string; text: string; beforeSend: () => Promise<boolean> }): Promise<{ status: "applied" | "idle" | "unsupported"; detail?: string }>;
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

export type AgentElicitationHandler = (
  request: CreateElicitationRequest,
  context: { signal: AbortSignal },
) => Promise<CreateElicitationResponse>;

export type AgentPermissionDecision = {
  outcome:
    | "allow_once"
    | "allow_always"
    | "reject_once"
    | "reject_always"
    | "cancel";
};

/** Consulted before the runtime's own permission policy answers an agent's
    permission request. `sessionId` is the Remote Agent session ID. Returning
    undefined defers to the policy (approve-all for unattended sessions), so
    interceptors can observe a request — e.g. capture a plan on exit-plan-mode
    approval — without owning the decision. */
export type AgentPermissionInterceptor = (
  input: { sessionId: string; raw: RequestPermissionRequest },
  context: { signal: AbortSignal },
) => Promise<AgentPermissionDecision | undefined>;
