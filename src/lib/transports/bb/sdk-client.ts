import { BBSdk, BbHttpError } from "bb-app";

import type {
  BbClient,
  BbEnvironment,
  BbEvent,
  BbMachine,
  BbModel,
  BbPendingInteraction,
  BbProvider,
  BbThread,
} from "../../../types/runtime/bb.ts";
import { normalizeBbError } from "./errors.ts";

const EVENT_PAGE_SIZE = 250;
const EVENT_POLL_MS = 500;

interface SdkThread {
  id: string;
  projectId: string;
  environmentId: string | null;
  environmentHostId?: string | null;
  host?: { id: string } | null;
  providerId: string;
  title: string | null;
  status: BbThread["status"];
  parentThreadId: string | null;
  archivedAt: number | null;
  createdAt?: number;
  visibility?: "visible" | "hidden";
}
type SdkEnvironment = Awaited<ReturnType<BBSdk["environments"]["get"]>>;
type SdkEvent = Awaited<ReturnType<BBSdk["threads"]["events"]["list"]>>[number];

function toThread(thread: SdkThread): BbThread {
  return {
    id: thread.id,
    projectId: thread.projectId,
    environmentId: thread.environmentId,
    hostId: thread.environmentHostId ?? thread.host?.id ?? null,
    providerId: thread.providerId,
    title: thread.title,
    status: thread.status,
    parentThreadId: thread.parentThreadId,
    archivedAt: thread.archivedAt,
    createdAt: thread.createdAt,
    visibility: thread.visibility,
  };
}

function toEnvironment(environment: SdkEnvironment): BbEnvironment {
  return {
    id: environment.id,
    projectId: environment.projectId,
    hostId: environment.hostId,
    path: environment.path,
    branchName: environment.branchName,
  };
}

function toEvent(event: SdkEvent): BbEvent {
  return {
    id: event.id,
    threadId: event.threadId,
    seq: event.seq,
    createdAt: event.createdAt,
    type: event.type,
    scope: event.scope,
    data: event.data,
  };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function createBbClient(baseUrl: string): BbClient {
  const sdk = new BBSdk({ baseUrl });

  return {
    async getThread(threadId) {
      try {
        return toThread(await sdk.threads.get({ threadId }));
      } catch (error) {
        if (error instanceof BbHttpError && error.status === 404) return null;
        throw normalizeBbError(error);
      }
    },
    async openThread(threadId) {
      try {
        return (await sdk.threads.open({ threadId, file: null })).delivered;
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async getThreadOutput(threadId) {
      try {
        return (await sdk.threads.output({ threadId })).output;
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async getThreadExecutionOptions(threadId) {
      try {
        return await sdk.threads.defaultExecutionOptions({ threadId });
      } catch (error) {
        if (error instanceof BbHttpError && error.status === 404) return null;
        throw normalizeBbError(error);
      }
    },
    async getEnvironment(environmentId) {
      try {
        return toEnvironment(await sdk.environments.get({ environmentId }));
      } catch (error) {
        if (error instanceof BbHttpError && error.status === 404) return null;
        throw normalizeBbError(error);
      }
    },
    async listThreads(input = {}) {
      try {
        const threads = await sdk.threads.list(input);
        return threads.map(toThread);
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async listProviders(input = {}) {
      try {
        const providers = input.environmentId
          ? await sdk.providers.list({ environmentId: input.environmentId })
          : input.hostId
            ? await sdk.providers.list({ hostId: input.hostId })
            : await sdk.providers.list();
        return providers.map<BbProvider>((provider) => ({
          id: provider.id,
          displayName: provider.displayName,
          available: provider.available,
          supportedPermissionModes:
            provider.capabilities.supportedPermissionModes,
        }));
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async listModels(input) {
      try {
        const result = input.environmentId
          ? await sdk.providers.models({
              environmentId: input.environmentId,
              providerId: input.providerId,
            })
          : input.hostId
            ? await sdk.providers.models({
                hostId: input.hostId,
                providerId: input.providerId,
              })
            : await sdk.providers.models({ providerId: input.providerId });
        const models = [...result.models, ...result.selectedOnlyModels];
        return [
          ...new Map(models.map((model) => [model.id, model])).values(),
        ].map<BbModel>((model) => ({
          id: model.id,
          model: model.model,
          displayName: model.displayName,
          description: model.description,
          supportedReasoningEfforts: model.supportedReasoningEfforts,
          defaultReasoningEffort: model.defaultReasoningEffort,
          isDefault: model.isDefault,
        }));
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async listEvents(input) {
      try {
        const events: BbEvent[] = [];
        let cursor = input.afterSeq ?? 0;
        while (true) {
          const page = (
            await sdk.threads.events.list({
              threadId: input.threadId,
              afterSeq: String(cursor),
              limit: String(EVENT_PAGE_SIZE),
            })
          ).map(toEvent);
          events.push(...page);
          if (page.length < EVENT_PAGE_SIZE) break;
          cursor = page.at(-1)?.seq ?? cursor;
        }
        return events;
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async listInteractions(threadId) {
      try {
        const interactions = await sdk.threads.interactions.list({ threadId });
        return interactions.map<BbPendingInteraction>((interaction) => ({
          id: interaction.id,
          threadId: interaction.threadId,
          status: interaction.status,
          payload: interaction.payload,
        }));
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async resolveInteraction(input) {
      try {
        await sdk.threads.interactions.resolve({
          threadId: input.threadId,
          interactionId: input.interactionId,
          resolution: input.resolution as Parameters<
            typeof sdk.threads.interactions.resolve
          >[0]["resolution"],
        });
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async sendMessage(input) {
      try {
        await sdk.threads.send({
          threadId: input.threadId,
          input: [{ type: "text", text: input.message, mentions: [] }],
          mode: input.mode ?? "queue-if-active",
          model: input.model,
          reasoningLevel: input.reasoningLevel,
          permissionMode: input.permissionMode,
          serviceTier: input.serviceTier,
        });
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async spawnThread(input) {
      try {
        const base = {
          projectId: input.projectId,
          providerId: input.providerId,
          model: input.model,
          title: input.title,
          permissionMode: input.permissionMode ?? "accept-edits",
          reasoningLevel: input.reasoningLevel,
          serviceTier: input.serviceTier,
          environment: {
            type: "host" as const,
            hostId: input.hostId,
            workspace: { type: "unmanaged" as const, path: input.worktreePath },
          },
          parentThreadId: input.parentThreadId,
          visibility: input.visibility,
          origin: "sdk" as const,
        };
        return toThread(
          input.promptVisibility
            ? await sdk.threads.spawn({
                ...base,
                input: [
                  {
                    type: "text",
                    text: input.prompt,
                    mentions: [],
                    visibility: input.promptVisibility,
                  },
                ],
              })
            : await sdk.threads.spawn({ ...base, prompt: input.prompt }),
        );
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async updateThreadExecutionOptions(input) {
      try {
        await sdk.threads.update({
          threadId: input.threadId,
          model: input.model,
          reasoningLevel: input.reasoningLevel,
        });
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async stopThread(threadId) {
      try {
        await sdk.threads.stop({ threadId });
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async archiveThread(threadId) {
      try {
        await sdk.threads.archive({ threadId });
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async listMachines() {
      try {
        const hosts = await sdk.hosts.list();
        return hosts.map<BbMachine>((host) => ({
          id: host.id,
          name: host.name,
          status: host.status,
        }));
      } catch (error) {
        throw normalizeBbError(error);
      }
    },
    async *streamEvents(input) {
      let cursor = input.afterSeq ?? 0;
      while (!input.signal?.aborted) {
        let page: BbEvent[];
        try {
          page = (
            await sdk.threads.events.list({
              threadId: input.threadId,
              afterSeq: String(cursor),
              limit: String(EVENT_PAGE_SIZE),
              signal: input.signal,
            })
          ).map(toEvent);
        } catch (error) {
          if (input.signal?.aborted) return;
          throw normalizeBbError(error);
        }
        if (page.length === 0) {
          await abortableDelay(EVENT_POLL_MS, input.signal);
          continue;
        }
        for (const event of page) {
          if (event.seq <= cursor) continue;
          cursor = event.seq;
          yield event;
        }
      }
    },
  };
}
