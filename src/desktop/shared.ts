import type { ConfigDocument } from "../lib/config-file.ts";
import type { ManagementResult } from "../management/service.ts";

export interface SessionSummary {
  id: string;
  repositoryId: string;
  machineId: string;
  name: string | null;
  status: string;
  role: string | null;
  agentCommand: string;
  cwd: string;
  worktreePath: string | null;
  updatedAt: string;
  tags: Array<{ key: string; value: string; source: string }>;
  resourceLinks: Array<{
    provider: string;
    connectionId: string;
    resourceType: string;
    externalId: string;
    relationship: string;
  }>;
}

export interface DesktopApi {
  config: {
    get(): Promise<ConfigDocument>;
    save(input: { expectedRevision: string; value: unknown }): Promise<ConfigDocument>;
    onChange(listener: (document: ConfigDocument) => void): () => void;
    openInEditor(): Promise<string | null>;
    reveal(): Promise<void>;
  };
  sessions: {
    list(repositoryId?: string): Promise<SessionSummary[]>;
  };
  management: {
    run(action: "status" | "doctor" | "install" | "check-update" | "update" | "restart"): Promise<ManagementResult>;
  };
}
