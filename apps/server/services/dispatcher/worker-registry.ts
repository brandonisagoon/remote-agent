import type { Worker } from "../../../../types/dispatcher/index.ts";
import { commentWorker } from "../../workers/product/comment/index.ts";
import { workflowWorker } from "../../workers/product/workflow/index.ts";

export const workers: Worker[] = [
  commentWorker,
  workflowWorker,
];
