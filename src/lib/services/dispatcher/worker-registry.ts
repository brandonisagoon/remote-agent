import type { Worker } from "../../../types/dispatcher/index.ts";
import { endSessionWorker } from "../../workers/agents/end-session/index.ts";
import { agentMentionWorker } from "../../workers/product/agent-mention/index.ts";
import { describeWorker } from "../../workers/product/describe/index.ts";
import { orchestrationWorker } from "../../workers/product/orchestration/index.ts";
import { reflectionWorker } from "../../workers/product/reflection/index.ts";

export const workers: Worker[] = [
  agentMentionWorker,
  describeWorker,
  reflectionWorker,
  orchestrationWorker,
  endSessionWorker,
];
