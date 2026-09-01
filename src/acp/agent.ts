import { randomUUID } from "node:crypto";
import path from "node:path";

import * as acp from "@agentclientprotocol/sdk";

import type { ServerConfig } from "../lib/config.ts";
import type {
  AgentRuntimeSession,
  AgentRuntimeTurn,
  AgentSessionRuntime,
} from "../types/runtime/index.ts";
import { acpLog } from "./log.ts";

const HARNESS_ID = "harness";
const MODEL_ID = "model";
const MODE_ID = "mode";
const REASONING_ID = "reasoning_effort";
const FAST_MODE_ID = "fast_mode";

function promptText(blocks: acp.ContentBlock[]): string {
  return blocks
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "resource_link") return [block.uri];
      return [];
    })
    .join("\n")
    .trim();
}

function agentForProvider(provider: "codex" | "claude-code"):
  "codex" | "claude" {
  return provider === "claude-code" ? "claude" : "codex";
}

function isSelect(
  option: acp.SessionConfigOption,
): option is acp.SessionConfigOption & { type: "select" } {
  return option.type === "select";
}

function optionIsModel(option: acp.SessionConfigOption): boolean {
  return option.category === "model" || option.id === "model";
}

function optionIsMode(option: acp.SessionConfigOption): boolean {
  return option.category === "mode" || option.id === "mode";
}

function optionIsReasoning(option: acp.SessionConfigOption): boolean {
  return (
    option.category === "thought_level" ||
    option.id === "effort" ||
    option.id === "reasoning_effort" ||
    option.id === "thinking"
  );
}

function optionIsFastMode(option: acp.SessionConfigOption): boolean {
  const id = option.id.toLowerCase();
  return (
    id === "fast_mode" ||
    id === "speed" ||
    id === "service_tier" ||
    (option.category === "model_config" && /fast|speed|service tier/i.test(option.name))
  );
}

function normalizeSelect(
  option: acp.SessionConfigOption,
  id: string,
  category: acp.SessionConfigOptionCategory,
): acp.SessionConfigOption {
  return isSelect(option)
    ? { ...option, id, category }
    : option;
}

function fastModeValue(option: acp.SessionConfigOption): boolean {
  if (option.type === "boolean") return option.currentValue;
  return /^(fast|priority|true|on)$/i.test(option.currentValue);
}

function fastSelectValues(option: acp.SessionConfigOption): {
  enabled: string;
  disabled: string;
} {
  if (!isSelect(option)) return { enabled: "true", disabled: "false" };
  const enabled = option.options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .find((entry) => /fast|priority/i.test(`${entry.value} ${entry.name}`))
    ?.value;
  const disabled = option.options
    .flatMap((entry) => ("options" in entry ? entry.options : [entry]))
    .find((entry) => /default|standard|normal|off/i.test(`${entry.value} ${entry.name}`))
    ?.value;
  return {
    enabled: enabled ?? "fast",
    disabled: disabled ?? "default",
  };
}

export class RemoteAgentAcpAgent implements acp.Agent {
  private booleanConfigOptions = false;
  private readonly activeTurns = new Map<string, AgentRuntimeTurn>();

  constructor(
    private readonly connection: acp.AgentSideConnection,
    private readonly runtime: AgentSessionRuntime,
    private readonly config: ServerConfig,
  ) {}

  async initialize(
    params: acp.InitializeRequest,
  ): Promise<acp.InitializeResponse> {
    this.booleanConfigOptions =
      params.clientCapabilities?.session?.configOptions?.boolean != null;
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentInfo: {
        name: "remote-agent",
        title: "Remote Agent",
        version: "0.1.0",
      },
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: false,
          audio: false,
          embeddedContext: false,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
          close: {},
        },
      },
    };
  }

  async authenticate(): Promise<acp.AuthenticateResponse> {
    return {};
  }

  async newSession(
    params: acp.NewSessionRequest,
  ): Promise<acp.NewSessionResponse> {
    const logicalKey = `zed:${randomUUID()}`;
    const session = await this.runtime.ensureSession({
      sessionKey: logicalKey,
      name: `Zed · ${path.basename(params.cwd) || "session"}`,
      agent: agentForProvider(this.config.acp.providerId),
      cwd: params.cwd,
      worktreePath: params.cwd,
      executionTarget: this.config.machine,
      machineId: this.config.machine,
      role: "primary",
      lifecycle: "persistent",
      model: this.config.acp.model,
      systemPrompt: "A Zed ACP session was created. Wait for the user's request.",
    });
    this.publishUsageAfterSetup(session);
    return {
      sessionId: session.id,
      configOptions: this.configOptions(session),
      _meta: this.sessionMeta(session),
    };
  }

  async loadSession(
    params: acp.LoadSessionRequest,
  ): Promise<acp.LoadSessionResponse> {
    const session = await this.requireSession(params.sessionId);
    for (const message of await this.runtime.history(session.id)) {
      await this.connection.sessionUpdate({
        sessionId: session.id,
        update: {
          sessionUpdate:
            message.role === "user"
              ? "user_message_chunk"
              : "agent_message_chunk",
          content: { type: "text", text: message.text },
        },
      });
    }
    this.publishUsageAfterSetup(session);
    return {
      configOptions: this.configOptions(session),
      _meta: this.sessionMeta(session),
    };
  }

  async resumeSession(
    params: acp.ResumeSessionRequest,
  ): Promise<acp.ResumeSessionResponse> {
    const session = await this.requireSession(params.sessionId);
    this.publishUsageAfterSetup(session);
    return {
      configOptions: this.configOptions(session),
      _meta: this.sessionMeta(session),
    };
  }

  async closeSession(
    params: acp.CloseSessionRequest,
  ): Promise<acp.CloseSessionResponse> {
    await this.runtime.close(params.sessionId, "Closed by Zed");
    return {};
  }

  async listSessions(
    params: acp.ListSessionsRequest = {},
  ): Promise<acp.ListSessionsResponse> {
    const sessions = await this.runtime.listSessions({
      cwd: params.cwd ?? undefined,
    });
    return {
      sessions: sessions.map((session) => ({
        sessionId: session.id,
        title: session.name ?? session.id,
        cwd: session.cwd,
        updatedAt: undefined,
        _meta: this.sessionMeta(session),
      })),
    };
  }

  async setSessionMode(
    params: acp.SetSessionModeRequest,
  ): Promise<acp.SetSessionModeResponse> {
    await this.runtime.setMode(params.sessionId, params.modeId);
    return {};
  }

  async setSessionConfigOption(
    params: acp.SetSessionConfigOptionRequest,
  ): Promise<acp.SetSessionConfigOptionResponse> {
    let session = await this.requireSession(params.sessionId);
    if (params.configId === HARNESS_ID) {
      if (typeof params.value !== "string") {
        throw acp.RequestError.invalidParams({ message: "harness must be a select value" });
      }
      if (params.value !== "codex" && params.value !== "claude") {
        throw acp.RequestError.invalidParams({ message: "unsupported harness" });
      }
      session = await this.runtime.switchAgent(session.id, params.value);
      return { configOptions: this.configOptions(session) };
    }

    const upstream = this.upstreamOption(session, params.configId);
    if (!upstream) {
      throw acp.RequestError.invalidParams({
        message: `unknown configuration option ${params.configId}`,
      });
    }

    let value: string;
    if (params.configId === FAST_MODE_ID) {
      const enabled =
        typeof params.value === "boolean"
          ? params.value
          : /^(fast|true|on)$/i.test(params.value);
      if (upstream.type === "boolean") {
        throw acp.RequestError.invalidParams({
          message:
            "the installed acpx runtime cannot yet forward upstream boolean controls",
        });
      }
      const values = fastSelectValues(upstream);
      value = enabled ? values.enabled : values.disabled;
    } else {
      if (typeof params.value !== "string") {
        throw acp.RequestError.invalidParams({ message: "select value required" });
      }
      value = params.value;
    }

    const complete = await this.runtime.setConfigOption(
      session.id,
      upstream.id,
      value,
    );
    session = { ...session, configOptions: complete };
    return { configOptions: this.configOptions(session) };
  }

  async prompt(params: acp.PromptRequest): Promise<acp.PromptResponse> {
    const message = promptText(params.prompt);
    if (!message) {
      throw acp.RequestError.invalidParams({ message: "text prompt required" });
    }
    await this.requireSession(params.sessionId);
    const turn = this.runtime.startTurn({
      sessionId: params.sessionId,
      text: message,
      mode: "prompt",
    });
    this.activeTurns.set(params.sessionId, turn);
    try {
      for await (const event of turn.events) {
        if (event.kind !== "update") continue;
        const update = event.update.sessionUpdate === "config_option_update"
          ? {
              sessionUpdate: "config_option_update" as const,
              configOptions: this.configOptions({
                ...(await this.requireSession(params.sessionId)),
                configOptions: event.update.configOptions,
              }),
            }
          : event.update;
        await this.connection.sessionUpdate({
          sessionId: params.sessionId,
          update,
        });
      }
      const result = await turn.result;
      if (result.status === "failed") throw new Error(result.error ?? "agent turn failed");
      return {
        stopReason:
          result.status === "cancelled"
            ? "cancelled"
            : this.stopReason(result.stopReason),
      };
    } finally {
      if (this.activeTurns.get(params.sessionId) === turn) {
        this.activeTurns.delete(params.sessionId);
      }
    }
  }

  async cancel(params: acp.CancelNotification): Promise<void> {
    const active = this.activeTurns.get(params.sessionId);
    if (active) await active.cancel("Cancelled by Zed");
    else {
      await this.runtime
        .cancel(params.sessionId, "Cancelled by Zed")
        .catch((error) => acpLog(`cancel failed for ${params.sessionId}`, error));
    }
  }

  private configOptions(session: AgentRuntimeSession): acp.SessionConfigOption[] {
    const normalized: acp.SessionConfigOption[] = [
      {
        id: HARNESS_ID,
        name: "Harness",
        description: "Agent harness backing this session.",
        category: "_harness",
        type: "select",
        currentValue: session.agent,
        options: [
          { value: "codex", name: "Codex" },
          { value: "claude", name: "Claude Code" },
        ],
      },
    ];
    let model = false;
    let mode = false;
    let reasoning = false;
    let fast = false;
    for (const option of session.configOptions) {
      if (!model && optionIsModel(option)) {
        normalized.push(normalizeSelect(option, MODEL_ID, "model"));
        model = true;
      } else if (!mode && optionIsMode(option)) {
        normalized.push(normalizeSelect(option, MODE_ID, "mode"));
        mode = true;
      } else if (!reasoning && optionIsReasoning(option)) {
        normalized.push(normalizeSelect(option, REASONING_ID, "thought_level"));
        reasoning = true;
      } else if (!fast && optionIsFastMode(option)) {
        const currentValue = fastModeValue(option);
        normalized.push(
          this.booleanConfigOptions
            ? {
                id: FAST_MODE_ID,
                name: "Fast Mode",
                description: "Use the provider's faster service tier when available.",
                category: "model_config",
                type: "boolean",
                currentValue,
              }
            : {
                id: FAST_MODE_ID,
                name: "Fast Mode",
                description: "Use the provider's faster service tier when available.",
                category: "model_config",
                type: "select",
                currentValue: currentValue ? "fast" : "default",
                options: [
                  { value: "default", name: "Standard" },
                  { value: "fast", name: "Fast" },
                ],
              },
        );
        fast = true;
      } else {
        normalized.push(option);
      }
    }
    return normalized;
  }

  private upstreamOption(
    session: AgentRuntimeSession,
    configId: string,
  ): acp.SessionConfigOption | null {
    if (configId === MODEL_ID) {
      return session.configOptions.find(optionIsModel) ?? null;
    }
    if (configId === MODE_ID) {
      return session.configOptions.find(optionIsMode) ?? null;
    }
    if (configId === REASONING_ID) {
      return session.configOptions.find(optionIsReasoning) ?? null;
    }
    if (configId === FAST_MODE_ID) {
      return session.configOptions.find(optionIsFastMode) ?? null;
    }
    return session.configOptions.find((option) => option.id === configId) ?? null;
  }

  private async requireSession(sessionId: string): Promise<AgentRuntimeSession> {
    const session = await this.runtime.getSession(sessionId);
    if (!session || session.status === "closed") {
      throw acp.RequestError.resourceNotFound(sessionId);
    }
    return session;
  }

  private publishUsageAfterSetup(session: AgentRuntimeSession): void {
    if (!session.usage) return;
    queueMicrotask(() => {
      void this.connection.sessionUpdate({
        sessionId: session.id,
        update: { sessionUpdate: "usage_update", ...session.usage! },
      }).catch((error) => acpLog(`usage restore failed for ${session.id}`, error));
    });
  }

  private sessionMeta(session: AgentRuntimeSession): Record<string, unknown> {
    return {
      remoteAgentSessionId: session.id,
      acpxRecordId: session.acpxRecordId,
      acpxSessionId: session.acpxSessionId,
      agentSessionId: session.agentSessionId,
      cwd: session.cwd,
      agent: session.agent,
      executionTarget: session.executionTarget,
    };
  }

  private stopReason(value: string | undefined): acp.StopReason {
    return value === "max_tokens" ||
        value === "max_turn_requests" ||
        value === "refusal" ||
        value === "cancelled"
      ? value
      : "end_turn";
  }
}
