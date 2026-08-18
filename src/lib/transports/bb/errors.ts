import { BbHttpError, BbRequestTimeoutError } from "bb-app";

import type { WorkerRunStatusValue } from "../../../types/dispatcher/worker-run.ts";

export type BbTransportErrorKind =
  | "not_found"
  | "rejected"
  | "timeout"
  | "unavailable"
  | "unknown";

export class BbTransportError extends Error {
  constructor(
    message: string,
    readonly kind: BbTransportErrorKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "BbTransportError";
  }
}

export function normalizeBbError(error: unknown): BbTransportError {
  if (error instanceof BbTransportError) return error;
  if (error instanceof BbRequestTimeoutError) {
    return new BbTransportError(error.message, "timeout", { cause: error });
  }
  if (error instanceof BbHttpError) {
    const kind = error.status === 404
      ? "not_found"
      : error.status === 409 || error.status === 422
        ? "rejected"
        : error.status >= 500
          ? "unavailable"
          : "unknown";
    return new BbTransportError(error.message, kind, { cause: error });
  }
  if (error instanceof TypeError) {
    return new BbTransportError(error.message, "unavailable", { cause: error });
  }
  return new BbTransportError(
    error instanceof Error ? error.message : String(error),
    "unknown",
    { cause: error },
  );
}

export function mapBbErrorToDispatchStatus(
  error: unknown,
): WorkerRunStatusValue {
  const normalized = normalizeBbError(error);
  if (normalized.kind === "not_found") return "stale_target";
  if (normalized.kind === "rejected") return "rejected";
  return "failed";
}
