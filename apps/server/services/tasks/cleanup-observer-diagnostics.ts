import { z } from "zod";
import { CleanupObserverBatchInput, CleanupObserverInput } from "./cleanup-observer-schema.ts";
import { CleanupWritersInput } from "./cleanup-writers-schema.ts";

const Name = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
const adapters = {
  "docker-container": "docker", "docker-network": "docker", "docker-volume": "docker",
  "docker-compose": "compose", "docker-compose-project": "compose", "task-runtime": "runtime", "planetscale-branch": "runtime",
  "native-app": "native", "local-process": "native", "local-http": "endpoint", "public-preview": "preview",
  "cloudflare-dns-record": "preview", "cloudflare-dns-route": "preview", "cloudflare-tunnel": "preview",
  "browser-profile": "browser", "clerk-test-user": "clerk", "clerk-test-session": "clerk", "browser-auth": "vault",
} as const;
export const CleanupObserverFailureCode = z.enum([
  "invalid-input", "input-too-large", "unsupported-resource", "invalid-observation", "ownership-mismatch", "identity-changed",
  "source-missing", "source-access-denied", "provider-timeout", "provider-unavailable", "provider-unauthorized", "provider-forbidden",
  "provider-rate-limited", "provider-response-invalid", "process-unverified", "preview-binding-missing", "resource-check-failed",
]);
export const CleanupObserverFailure = z.strictObject({ version: z.literal(1), type: z.literal("cleanup-observer-failure"),
  stage: z.enum(["input", "resource", "writers", "output"]), code: CleanupObserverFailureCode,
  resource: z.strictObject({ id: Name, key: Name, kind: z.enum(Object.keys(adapters) as [keyof typeof adapters, ...Array<keyof typeof adapters>]),
    adapter: z.enum(["docker", "compose", "runtime", "native", "endpoint", "preview", "browser", "clerk", "vault"]) }).optional(),
});
type Failure = z.infer<typeof CleanupObserverFailure>;
type Resource = NonNullable<Failure["resource"]>;

/** Fixed reasons only. These are diagnostics, never physical proof or authority. */
export const cleanupObserverReasons = {
  OBSERVER_COMPATIBILITY: "The configured observer does not declare retained-preview-inputs/v1 compatibility.",
  OBSERVER_CAPABILITY: "The committed observer capability could not be verified.",
  OBSERVER_TIMEOUT: "The read-only observer exceeded its deadline.",
  OBSERVER_EXIT: "The read-only observer exited unsuccessfully.",
  OBSERVER_STDERR: "The observer wrote unexpected standard error.",
  OBSERVER_OUTPUT_LIMIT: "The observer output exceeded its byte limit.",
  OBSERVER_JSON: "The observer returned invalid or incomplete JSON.",
  OBSERVER_GROUP: "The owned observer process group could not be confirmed absent.",
  OBSERVER_TRANSPORT: "The observer input/output transport did not complete.",
  OBSERVER_INPUT: "The observer request or deadline is invalid or too large.",
  OBSERVER_INVALID_INPUT: "The observer rejected its request schema.",
  OBSERVER_INPUT_TOO_LARGE: "The observer rejected an oversized request.",
  OBSERVER_UNSUPPORTED_RESOURCE: "The selected resource has no supported observer.",
  OBSERVER_INVALID_OBSERVATION: "The resource observation did not match its schema.",
  OBSERVER_OWNERSHIP_MISMATCH: "The recorded resource ownership did not match.",
  OBSERVER_IDENTITY_CHANGED: "The recorded resource identity changed.",
  OBSERVER_SOURCE_MISSING: "A required recorded input was not found.",
  OBSERVER_SOURCE_ACCESS_DENIED: "Access to a required recorded input was denied.",
  OBSERVER_PROVIDER_TIMEOUT: "The resource provider check timed out.",
  OBSERVER_PROVIDER_UNAVAILABLE: "The resource provider check was unavailable.",
  OBSERVER_PROVIDER_UNAUTHORIZED: "The resource provider rejected authentication.",
  OBSERVER_PROVIDER_FORBIDDEN: "The resource provider refused access.",
  OBSERVER_PROVIDER_RATE_LIMITED: "The resource provider rate-limited the check.",
  OBSERVER_PROVIDER_RESPONSE_INVALID: "The resource provider returned an invalid response.",
  OBSERVER_PROCESS_UNVERIFIED: "The exact process identity or absence was unverified.",
  OBSERVER_PREVIEW_BINDING_MISSING: "The preview receipt has no verified hostname and tunnel binding.",
  OBSERVER_RESOURCE_CHECK_FAILED: "The selected resource check failed.",
} as const;
export type CleanupObserverCode = keyof typeof cleanupObserverReasons;
const clientCodes: Record<Failure["code"], CleanupObserverCode> = {
  "invalid-input": "OBSERVER_INVALID_INPUT", "input-too-large": "OBSERVER_INPUT_TOO_LARGE", "unsupported-resource": "OBSERVER_UNSUPPORTED_RESOURCE",
  "invalid-observation": "OBSERVER_INVALID_OBSERVATION", "ownership-mismatch": "OBSERVER_OWNERSHIP_MISMATCH", "identity-changed": "OBSERVER_IDENTITY_CHANGED",
  "source-missing": "OBSERVER_SOURCE_MISSING", "source-access-denied": "OBSERVER_SOURCE_ACCESS_DENIED", "provider-timeout": "OBSERVER_PROVIDER_TIMEOUT",
  "provider-unavailable": "OBSERVER_PROVIDER_UNAVAILABLE", "provider-unauthorized": "OBSERVER_PROVIDER_UNAUTHORIZED", "provider-forbidden": "OBSERVER_PROVIDER_FORBIDDEN",
  "provider-rate-limited": "OBSERVER_PROVIDER_RATE_LIMITED", "provider-response-invalid": "OBSERVER_PROVIDER_RESPONSE_INVALID", "process-unverified": "OBSERVER_PROCESS_UNVERIFIED",
  "preview-binding-missing": "OBSERVER_PREVIEW_BINDING_MISSING", "resource-check-failed": "OBSERVER_RESOURCE_CHECK_FAILED",
};
function reason(code: CleanupObserverCode, resource?: Resource) {
  // Long safe registry keys remain exact in the typed diagnostic; the existing
  // preparation reason contract is bounded to 320 characters.
  const key = resource && (resource.key.length > 80 ? `${resource.key.slice(0, 80)}…` : resource.key);
  return `${cleanupObserverReasons[code]}${resource ? ` Resource ${key} (${resource.kind}/${resource.adapter}).` : ""} The resource absence is unverified.`;
}
export class CleanupObserverError extends Error {
  #code: CleanupObserverCode;
  #resource?: Resource;
  constructor(code: CleanupObserverCode, resource?: Resource) {
    const safeCode = Object.hasOwn(cleanupObserverReasons, code) ? code : "OBSERVER_TRANSPORT";
    const parsed = CleanupObserverFailure.shape.resource.safeParse(resource);
    const safeResource = parsed.success && parsed.data && adapters[parsed.data.kind] === parsed.data.adapter ? parsed.data : undefined;
    super(`[${safeCode}] ${reason(safeCode, safeResource)}`);
    this.#code = safeCode; this.#resource = safeResource;
  }
  get diagnostic() { return { code: this.#code, reason: reason(this.#code, this.#resource) }; }
}

/** A failure may name only the exact selected request resource. Arbitrary
 * stderr, extra lines/fields, unselected identities and unsafe names are omitted. */
export function observerFailureEnvelope(stderr: string, request: unknown): CleanupObserverError | null {
  if (Buffer.byteLength(stderr) > 2048) return null;
  const line = stderr.replace(/\r?\n$/, "");
  if (/[\r\n]/.test(line)) return null;
  let value: unknown;
  try { value = JSON.parse(line); } catch { return null; }
  const parsed = CleanupObserverFailure.safeParse(value);
  if (!parsed.success) return null;
  const failure = parsed.data, resource = failure.resource;
  if (resource) {
    if (!["resource", "writers"].includes(failure.stage) || adapters[resource.kind] !== resource.adapter) return null;
    const batch = CleanupObserverBatchInput.safeParse(request), single = CleanupObserverInput.safeParse(request), writers = CleanupWritersInput.safeParse(request);
    const selected = failure.stage === "writers" && writers.success
      ? writers.data.resources.filter(item => writers.data.writerResourceIds.includes(item.id))
      : failure.stage === "resource" && batch.success ? batch.data.resources.filter(item => batch.data.observations.some(observation => observation.resourceId === item.id))
        : failure.stage === "resource" && single.success ? [single.data.resource] : [];
    if (!selected.some(item => item.id === resource.id && item.key === resource.key && item.kind === resource.kind)) return null;
  }
  return new CleanupObserverError(clientCodes[failure.code], resource);
}
