/** Cross-boundary values, not authority grants. Services validate these against
 * durable ownership, request identity and the immutable checkout. */
export interface ToolingStateFormat {
  read: number[];
  write: number;
  /** All supported write versions, including migrations. Omitted means [write]. */
  writeVersions?: number[];
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
  /** Command binding from which this callback inherited its immutable release.
   * Absent/null identifies a root operation; never a provider-resource ID. */
  parentOperationId?: string | null;
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
  parentOperationId?: string;
  resourceKey?: string;
}

/** State API values are evidence for the owning operation and task only.
 * Unknown retained provenance is a 409 refusal, never an empty consumer list. */
export interface ToolingStateEvidenceResponse {
  operationId: string;
  taskId: string;
  family: string;
  scopeKey: string;
  version: number | null;
  source: "recorded" | "legacy-assumed" | "none";
  consumers: Array<{
    /** Exact operation ID, or `legacy:<consumer-id>` for a retained legacy row. */
    operationId: string;
    /** Null only for a proven pre-protocol reader, never unknown provenance. */
    format: ToolingStateFormat | null;
  }>;
}

export interface ToolingStateWriteRequest {
  family: string;
  scopeKey: string;
  version: number;
}

export interface ToolingStateWriteResponse {
  operationId: string;
  taskId: string;
  family: string;
  scopeKey: string;
  write: {
    version: number;
    preservesUnknown: boolean;
    operationId: string;
    releaseId: string;
    sequence: number;
  };
}
