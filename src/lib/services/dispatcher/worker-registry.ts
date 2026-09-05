import type { Worker } from "../../../types/dispatcher/index.ts";
import { agentMentionWorker } from "../../workers/product/agent-mention/index.ts";
import { workflowWorker } from "../../workers/product/workflow/index.ts";

export const workers: Worker[] = [
  agentMentionWorker,
  workflowWorker,
];
