/** Cross-boundary values, not authority grants. Services validate these against
 * durable ownership, request identity and the immutable checkout. */
export interface ToolingStateFormat {
  read: number[];
  write: number;
  preservesUnknown: boolean;
}

export interface ToolingReleaseManifest {
  contract: "remote-agent.tooling-release/v1";
  serverProtocol: { min: number; max: number };
  stateFormats: Record<string, ToolingStateFormat>;
}

export interface ToolingReleaseRecord {
  id: string;
  repositoryId: string;
  revision: string;
  tree: string;
  policyBlob: string;
  checkout: string;
  manifest: ToolingReleaseManifest;
}

export interface ToolingReleaseSelection {
  repositoryId: string;
  generation: number;
  release: ToolingReleaseRecord;
}

export interface ToolingOperationBinding {
  contract: "remote-agent.tooling-operation/v1";
  operationId: string;
  requestKey: string;
  inputDigest: string;
  repositoryId: string;
  taskId: string;
  sessionId: string;
  turnId: string | null;
  kind: string;
  existingOperationId: string | null;
  resourceKey: string | null;
  generation: number;
  release: ToolingReleaseRecord;
  status: "bound" | "running" | "unknown" | "completed";
}

export interface BeginToolingOperationRequest {
  requestKey: string;
  inputDigest: string;
  kind: string;
  existingOperationId?: string;
  resourceKey?: string;
}
