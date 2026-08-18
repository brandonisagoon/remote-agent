import type { Machine } from "../../../../../../types/sessions/index.ts";

export interface QueryAgentIssueInput {
  id: string;
}

export type QueryAgentIssuesInput =
  | { searchTerm: string }
  | { harnessSessionId: string }
  | {
      locator: {
        machine: Machine;
        bbThreadId: string;
      };
    }
  | { machine: Machine };

export type {
  CreateAgentIssueInput,
  UpdateAgentIssueInput,
} from "../../../../../../types/sessions/index.ts";
