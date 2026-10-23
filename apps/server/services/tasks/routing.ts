import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { TaskPlacement } from "../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../lib/config.ts";

export type RoutingRequest = (machineId: string, method: string, route: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>;
export function routingRequest(config: ServerConfig, local: (request: Request) => Response | Promise<Response>): RoutingRequest {
  return async (machineId, method, route, body, headers = {}) => {
    if (machineId === config.machine) return local(new Request(`http://remote-agent${route}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    const peer = config.routing?.peers[machineId];
    if (!peer) throw new Error("Owning host is no longer configured; placement is preserved");
    return fetch(new URL(route, peer.url), { method, redirect: "error", signal: AbortSignal.timeout(30_000), headers: { "content-type": "application/json", ...headers, authorization: `Bearer ${peer.apiKey}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  };
}

export function assertPlacementHost(config: ServerConfig, machineId: string, repositoryId: string) {
  if (!config.repositories[repositoryId]) throw new Error("Unknown repository");
  if (machineId !== config.machine && !config.routing?.peers[machineId]?.repositories.includes(repositoryId)) throw new Error("Host is not configured for this repository");
}

export async function placeTask(prisma: PrismaClient, config: ServerConfig, input: { sourceKey: string; machineId: string; repositoryId: string }) {
  assertPlacementHost(config, input.machineId, input.repositoryId);
  const placement = await prisma.taskPlacement.upsert({ where: { sourceKey: input.sourceKey }, update: {}, create: input });
  if (placement.machineId !== input.machineId || placement.repositoryId !== input.repositoryId) throw new Error("Placement already belongs to another host or repository; running tasks cannot migrate");
  return placement;
}

export async function queueRoutedRequest(prisma: PrismaClient, input: { placementId: string; requestKey: string; kind: "launch" | "instruction" | "linear" | "question" | "automation"; payload: Record<string, any> }) {
  const delivery = await prisma.taskDelivery.upsert({ where: { requestKey: input.requestKey }, update: {}, create: input });
  if (delivery.placementId !== input.placementId || delivery.kind !== input.kind || !isDeepStrictEqual(delivery.payload, input.payload)) throw new Error("Delivery request key already belongs to another request");
  return delivery;
}

export async function resolvePlacementTask(prisma: PrismaClient, placement: TaskPlacement, request: RoutingRequest) {
  if (placement.taskId) return placement.taskId;
  const match = /^linear:([^:]+):(.+)$/.exec(placement.sourceKey);
  if (!match) return null;
  const response = await request(placement.machineId, "GET", `/api/routing/source-task?connectionId=${encodeURIComponent(match[1]!)}&issueId=${encodeURIComponent(match[2]!)}&repositoryId=${encodeURIComponent(placement.repositoryId)}`);
  if (!response.ok) throw new Error("Could not resolve the task on its recorded owner");
  const result = z.object({ task: z.object({ id: z.string(), machineId: z.string(), repositoryId: z.string() }).nullable() }).parse(await response.json());
  if (!result.task) return null;
  if (result.task.machineId !== placement.machineId || result.task.repositoryId !== placement.repositoryId) throw new Error("Source task reports a different owner or repository");
  await prisma.taskPlacement.update({ where: { id: placement.id }, data: { taskId: result.task.id } });
  return result.task.id;
}

/** Signature, freshness and the owner filter must pass before this is called. */
export async function routeLinearDelivery(input: { prisma: PrismaClient; config: ServerConfig; webhookId: string; connectionId: string; repositoryId: string; deliveryId: string; webhook: Record<string, any> }) {
  const { prisma, config, webhook } = input;
  const data = webhook.data ?? {};
  const issueId = webhook.type === "Issue" ? data.id : data.issueId ?? data.issue?.id ?? data.comment?.issueId ?? data.comment?.issue?.id;
  if (typeof issueId !== "string" || !issueId) throw new Error("Webhook has no stable issue identity; cannot place it safely");
  const sourceKey = `linear:${input.connectionId}:${issueId}`;
  const existing = await prisma.taskPlacement.findUnique({ where: { sourceKey } });
  const placement = existing ?? await placeTask(prisma, config, { sourceKey, repositoryId: input.repositoryId, machineId: config.routing?.connectionHosts[input.connectionId] ?? config.machine });
  if (placement.repositoryId !== input.repositoryId) throw new Error("Issue repository changed; existing placement is preserved");
  const delivery = await queueRoutedRequest(prisma, { placementId: placement.id, requestKey: `linear:${input.connectionId}:${input.deliveryId}`, kind: "linear", payload: { webhookId: input.webhookId, deliveryId: input.deliveryId, webhook } });
  return { placement, delivery };
}

const flushing = new WeakSet<PrismaClient>();
export async function dispatchPlacements(prisma: PrismaClient, request: RoutingRequest) {
  if (flushing.has(prisma)) return;
  flushing.add(prisma);
  try {
    const deliveries = await prisma.taskDelivery.findMany({ where: { state: { in: ["queued", "retrying", "sending"] }, retryAt: { lte: new Date() } }, include: { placement: true }, orderBy: { sequence: "asc" }, take: 50 });
    const visited = new Set<string>();
    for (const delivery of deliveries) {
      if (visited.has(delivery.placementId)) continue;
      visited.add(delivery.placementId);
      const previous = await prisma.taskDelivery.count({ where: { placementId: delivery.placementId, sequence: { lt: delivery.sequence }, state: { not: "acknowledged" } } });
      if (previous) continue;
      const claim = await prisma.taskDelivery.updateMany({ where: { id: delivery.id, state: delivery.state, attempts: delivery.attempts }, data: { state: "sending", attempts: { increment: 1 }, retryAt: new Date(Date.now() + 60_000) } });
      if (!claim.count) continue;
      try {
        const payload = z.record(z.string(), z.any()).parse(delivery.payload);
        let response: Response;
        if (delivery.kind === "launch") {
          response = await request(delivery.placement.machineId, "POST", "/api/tasks", { ...payload, requestKey: `placement:${delivery.placement.id}` });
        } else if (["instruction", "question", "automation"].includes(delivery.kind)) {
          const taskId = await resolvePlacementTask(prisma, delivery.placement, request);
          if (!taskId) throw new Error("Waiting for the owning task's launch receipt");
          const base = `/api/tasks/${encodeURIComponent(taskId)}`;
          if (delivery.kind === "question") response = await request(delivery.placement.machineId, "POST", `${base}/questions/${encodeURIComponent(payload.questionId)}/answer`, { answer: payload.answer });
          else if (delivery.kind === "automation") response = await request(delivery.placement.machineId, "POST", `${base}/automation`, { action: payload.action });
          else response = await request(delivery.placement.machineId, "POST", `${base}/instructions`, { ...payload, requestKey: delivery.id });
        } else if (delivery.kind === "linear") {
          response = await request(delivery.placement.machineId, "POST", `/api/routing/linear/${encodeURIComponent(payload.webhookId)}`, payload.webhook, { "linear-delivery": payload.deliveryId });
        } else throw new Error("Unknown delivery kind");
        const value = z.record(z.string(), z.json()).parse(await response.json());
        if (!response.ok) {
          const permanent = response.status >= 400 && response.status < 500 && ![408, 409, 429].includes(response.status);
          await prisma.taskDelivery.update({ where: { id: delivery.id }, data: { state: permanent ? "failed" : "retrying", detail: `Owning host returned ${response.status}`, retryAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(delivery.attempts, 6))) } });
          continue;
        }
        if (delivery.kind === "launch") {
          const task = z.object({ task: z.object({ id: z.string(), machineId: z.string(), repositoryId: z.string() }) }).parse(value).task;
          if (task.machineId !== delivery.placement.machineId || task.repositoryId !== delivery.placement.repositoryId) throw new Error("Launch receipt reports a different host or repository");
          await prisma.taskPlacement.update({ where: { id: delivery.placementId }, data: { taskId: task.id } });
        }
        await prisma.taskDelivery.update({ where: { id: delivery.id }, data: { state: "acknowledged", response: value, detail: null } });
      } catch {
        // Requests are idempotent at their destination. Never fail over to a
        // different machine when an acknowledgement is lost.
        await prisma.taskDelivery.update({ where: { id: delivery.id }, data: { state: "retrying", detail: "Owning host unreachable or response uncertain; retrying the same identity", retryAt: new Date(Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(delivery.attempts, 6))) } });
      }
    }
  } finally { flushing.delete(prisma); }
}

export function startPlacementDelivery(prisma: PrismaClient, request: RoutingRequest) {
  const tick = () => void dispatchPlacements(prisma, request).catch(() => console.error("Placement reconciliation failed"));
  const timer = setInterval(tick, 1000);
  timer.unref(); tick();
  return () => clearInterval(timer);
}
