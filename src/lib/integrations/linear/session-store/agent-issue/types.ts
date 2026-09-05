import type { Machine } from "../../../../../types/sessions/index.ts";

export interface QueryAgentIssueInput {
  id: string;
}

export type QueryAgentIssuesInput =
  | { searchTerm: string }
  | { harnessSessionId: string }
  | { machine: Machine };

export type {
  CreateAgentIssueInput,
  UpdateAgentIssueInput,
} from "../../../../../types/sessions/index.ts";
