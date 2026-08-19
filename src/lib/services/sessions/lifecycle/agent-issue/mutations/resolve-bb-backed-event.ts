import type { ServerConfig } from "../../../../../config.ts";
import { getMachine } from "../../../../../machines/index.ts";
import type { BbClient, BbEvent, BbThread } from "../../../../../../types/runtime/index.ts";
import type { RuntimeSessionEvent } from "../../../../../../types/sessions/index.ts";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function providerThreadId(event: BbEvent): string | null {
  if (event.type !== "thread/identity") return null;
  const value = record(event.data)?.providerThreadId;
  return typeof value === "string" ? value : null;
}

async function ownsProviderSession(
  bbClient: BbClient,
  thread: BbThread,
  event: RuntimeSessionEvent,
  expectedHostId: string | undefined,
): Promise<boolean> {
  if (expectedHostId && thread.hostId !== expectedHostId) return false;
  if (thread.environmentId) {
    const environment = await bbClient.getEnvironment(thread.environmentId);
    if (environment?.path && environment.path !== event.runtime.worktreePath) {
      return false;
    }
  }
  const events = await bbClient.listEvents({ threadId: thread.id });
  return events.some(
    (candidate) => providerThreadId(candidate) === event.runtime.harnessSessionId,
  );
}

/**
 * Provider lifecycle hooks identify a bb-backed session by the provider's own
 * UUID. bb's canonical thread ID is intentionally different. Resolve that
 * identity before entering the per-session write queue so both event sources
 * update one registry issue rather than racing to create two mirrors.
 */
export async function resolveBbBackedEvent(
  config: ServerConfig,
  event: RuntimeSessionEvent,
  bbClient: BbClient,
): Promise<RuntimeSessionEvent> {
  if (event.runtime.bbThreadId || event.runtime.parentSessionId) return event;

  const providerId = event.runtime.harness === "claude" ? "claude-code" : "codex";
  const threads = await bbClient.listThreads({
    projectId: config.bbProjectId,
    archived: false,
  });
  const candidates = threads.filter((thread) => thread.providerId === providerId);
  const matches = (
    await Promise.all(
      candidates.map(async (thread) =>
        (await ownsProviderSession(
          bbClient,
          thread,
          event,
          getMachine({ id: event.runtime.machine }).bbHostId,
        ))
          ? thread
          : null,
      ),
    )
  ).filter((thread) => thread != null);

  if (matches.length !== 1) return event;
  const thread = matches[0]!;
  return {
    ...event,
    runtime: {
      ...event.runtime,
      harnessSessionId: thread.id,
      bbThreadId: thread.id,
    },
  };
}
