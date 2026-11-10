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
  serverContracts?: string[];
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
  /** Server-only continuation provenance; never accepted in public begin requests. */
  retainedConsumerId?: string | null;
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

/** Canonical input for one already-owned legacy resource's closed-task
 * cleanup. The begin request carries its digest and resourceKey=key; this
 * operation cannot parent callbacks or authorize starts, resumes or migration. */
export interface ClosedResourceReleaseInput {
  key: string;
  action: "reconcile" | "stop" | "release";
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

/** An adapter reports its command outcome using the same durable identity.
 * This settles the fence only; child operations and live consumers keep their
 * own lifetimes. Unknown outcomes retain the journal and send no success. */
export interface ToolingCommandSettlementRequest {
  requestKey: string;
  inputDigest: string;
  outcome: "completed" | "no-effect";
}

export interface ToolingCommandSettlementResponse {
  binding: ToolingOperationBinding;
  outcome: "completed" | "no-effect";
}
