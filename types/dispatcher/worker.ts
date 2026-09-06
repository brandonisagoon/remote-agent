import type { PrismaClient } from "../../generated/prisma/client.ts";
import type { ServerConfig } from "../../lib/config.ts";
import type { CommandClient } from "../runtime/command.ts";
import type { AgentSessionRuntime } from "../runtime/agent-runtime.ts";
import type { DispatchEvent } from "./event.ts";
import type { WorkerResult } from "./worker-run.ts";

export interface WorkerContext {
  prisma: PrismaClient;
  config: ServerConfig;
  commandClient: CommandClient;
  agentRuntime?: AgentSessionRuntime;
  runId: string;
}

export interface Worker<TEvent extends DispatchEvent = DispatchEvent> {
  key: string;
  supports(event: DispatchEvent): event is TEvent;
  execute(event: TEvent, context: WorkerContext): Promise<WorkerResult>;
}
