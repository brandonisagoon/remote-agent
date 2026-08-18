import type { BbEvent } from "../../../../types/runtime/index.ts";

export const RECOVERY_MARKER = "✅ Recovered";
export const REPEAT_MARKER = "❌ Repeated";

const NO_PROVIDER_DETAIL = "No provider error detail was returned.";
const NO_RUNTIME_DETAIL = "No runtime error detail was returned.";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function boolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export interface ProviderErrorData {
  message: string | null;
  detail: string | null;
  errorInfo: {
    category: string | null;
    providerCode: string | null;
    httpStatusCode: number | null;
  } | null;
  willRetry: boolean | null;
}

export interface SystemErrorData {
  code: string | null;
  message: string | null;
  detail: string | null;
  reconnectAttempt: number | null;
  reconnectTotal: number | null;
}

export interface BbNoticeContext {
  threadLink: string;
  machine: string;
  harness: string;
}

export function parseProviderErrorData(data: unknown): ProviderErrorData {
  const value = record(data);
  const rawErrorInfo = record(value?.errorInfo);
  const errorInfo = rawErrorInfo
    ? {
        category: text(rawErrorInfo.category),
        providerCode: text(rawErrorInfo.providerCode),
        httpStatusCode: number(rawErrorInfo.httpStatusCode),
      }
    : null;
  return {
    message: text(value?.message),
    detail: text(value?.detail),
    errorInfo,
    willRetry: boolean(value?.willRetry),
  };
}

export function parseSystemErrorData(data: unknown): SystemErrorData {
  const value = record(data);
  const reconnect = record(value?.reconnect);
  return {
    code: text(value?.code),
    message: text(value?.message),
    detail: text(value?.detail),
    reconnectAttempt:
      number(value?.reconnectAttempt) ?? number(reconnect?.attempt),
    reconnectTotal: number(value?.reconnectTotal) ?? number(reconnect?.total),
  };
}

export function parseFailedTurnErrorMessage(data: unknown): string | null {
  const value = record(data);
  return text(record(value?.error)?.message);
}

export function isBbErrorEvent(event: BbEvent): boolean {
  if (event.type === "provider/error" || event.type === "system/error") {
    return true;
  }
  return (
    event.type === "turn/completed" &&
    record(event.data)?.status === "failed"
  );
}

function retryLine(willRetry: boolean | null): string {
  if (willRetry === true) return "bb will retry this turn automatically.";
  if (willRetry === false) {
    return "bb will not retry; operator intervention is likely needed.";
  }
  return (
    "bb did not report whether it will retry; a recovery note will be added " +
    "here if the session resumes."
  );
}

function contextLines(event: BbEvent, context: BbNoticeContext): string[] {
  return [
    ...(event.scope.kind === "turn"
      ? [`- Turn: \`${event.scope.turnId}\``]
      : []),
    `- Machine: \`${context.machine}\` · Harness: \`${context.harness}\``,
    `- Thread: [Open in bb](${context.threadLink})`,
  ];
}

export function buildBbErrorNotice(
  event: BbEvent,
  context: BbNoticeContext,
): string | null {
  if (!isBbErrorEvent(event)) return null;

  if (event.type === "system/error") {
    const data = parseSystemErrorData(event.data);
    const detail = data.detail ?? data.message ?? NO_RUNTIME_DETAIL;
    return [
      `❌ bb runtime error${data.code ? ` — ${data.code}` : ""}`,
      "",
      `> ${detail}`,
      "",
      ...contextLines(event, context),
      ...(data.reconnectAttempt !== null
        ? [
            `- Reconnect: attempt ${data.reconnectAttempt}${
              data.reconnectTotal !== null ? ` of ${data.reconnectTotal}` : ""
            }`,
          ]
        : []),
    ].join("\n");
  }

  const provider =
    event.type === "provider/error"
      ? parseProviderErrorData(event.data)
      : null;
  const detail = provider
    ? provider.detail ?? provider.message ?? NO_PROVIDER_DETAIL
    : parseFailedTurnErrorMessage(event.data) ?? NO_PROVIDER_DETAIL;
  const category = provider?.errorInfo?.category;
  const httpStatus = provider?.errorInfo?.httpStatusCode;
  const headline = [
    "❌ bb agent error",
    category ? ` — ${category}` : "",
    httpStatus !== null && httpStatus !== undefined
      ? ` (HTTP ${httpStatus})`
      : "",
  ].join("");
  return [
    headline,
    "",
    `> ${detail}`,
    "",
    ...contextLines(event, context),
    `- Retry: ${retryLine(provider?.willRetry ?? null)}`,
  ].join("\n");
}

export function buildSessionRootComment(input: {
  threadLink: string;
  machine: string;
  harness: string;
  provider: string | null;
  model: string | null;
}): string {
  const runtime = [
    input.machine,
    input.harness,
    input.provider,
    input.model,
  ].flatMap((value) => (value ? [`\`${value}\``] : []));
  return [
    `● bb agent session · [Open Thread in bb](${input.threadLink})`,
    "",
    runtime.join(" · "),
    "",
    "Checkpoints, questions, and error notices for this session are threaded below.",
  ].join("\n");
}

function duration(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export function buildRecoveryAppendix(input: {
  recoveredAtMs: number;
  errorAt: Date;
}): string {
  return [
    "",
    "---",
    "",
    `${RECOVERY_MARKER} — the agent resumed after ${duration(
      input.recoveredAtMs - input.errorAt.getTime(),
    )}.`,
  ].join("\n");
}

function repeatSummary(event: BbEvent): string {
  if (event.type === "provider/error") {
    const data = parseProviderErrorData(event.data);
    const category = data.errorInfo?.category;
    const detail = data.detail ?? data.message ?? NO_PROVIDER_DETAIL;
    return `${category ? `${category}: ` : ""}${detail}`;
  }
  if (event.type === "system/error") {
    const data = parseSystemErrorData(event.data);
    const category = data.code ?? "runtime error";
    return `${category}: ${data.detail ?? data.message ?? NO_RUNTIME_DETAIL}`;
  }
  return parseFailedTurnErrorMessage(event.data) ?? NO_PROVIDER_DETAIL;
}

export function buildRepeatAppendix(
  event: BbEvent,
  _context: BbNoticeContext,
): string {
  return ["", "---", "", `${REPEAT_MARKER} — ${repeatSummary(event)}`].join(
    "\n",
  );
}
