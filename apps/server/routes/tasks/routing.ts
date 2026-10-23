import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../middleware/context.ts";
import { MachineSchema } from "../../../../lib/machines/registry.ts";
import { isSafeBranchName } from "../../workers/product/workflow/branch.ts";
import { placeTask, queueRoutedRequest, routingRequest, resolvePlacementTask } from "../../services/tasks/routing.ts";
import { scopeConfig } from "../../../../lib/config.ts";
import { getSourceIssueForWorkflow } from "../../integrations/linear/session-store/source-issue/index.ts";

export const taskRoutingRoutes = new Hono<AppEnv>();
const Key = z.string().min(1).max(200);
const Launch = z.object({ requestKey: Key, machineId: MachineSchema, repositoryId: Key, branchName: z.string().refine(isSafeBranchName), prompt: z.string().min(1).max(100_000), provider: z.enum(["codex", "claude"]).default("codex") }).strict();

taskRoutingRoutes.get("/source-task", async (c) => {
  const connectionId = c.req.query("connectionId"), issueId = c.req.query("issueId"), repositoryId = c.req.query("repositoryId");
  if (!connectionId || !issueId || !repositoryId || !c.get("config").connections[connectionId] || !c.get("config").repositories[repositoryId]) return c.json({ error: "Known source connection, repository and issue required" }, 400);
  const config = scopeConfig(c.get("config"), { connectionId, repositoryId });
  const issue = await getSourceIssueForWorkflow(config, { id: issueId });
  if (!issue) return c.json({ error: "Source issue unavailable" }, 404);
  const task = await c.get("prisma").remoteTask.findFirst({ where: { connectionId, repositoryId, issueIdentifier: issue.identifier }, orderBy: { createdAt: "desc" } });
  return c.json({ task });
});

taskRoutingRoutes.get("/hosts", (c) => {
  const config = c.get("config");
  return c.json({ hosts: [{ machineId: config.machine, repositories: Object.keys(config.repositories), local: true }, ...Object.entries(config.routing?.peers ?? {}).map(([machineId, peer]) => ({ machineId, repositories: peer.repositories, local: false }))] });
});
taskRoutingRoutes.get("/placements", async (c) => c.json({ placements: await c.get("prisma").taskPlacement.findMany({ include: { deliveries: { orderBy: { sequence: "desc" }, take: 20 } }, orderBy: { updatedAt: "desc" }, take: 100 }) }));
taskRoutingRoutes.post("/launches", async (c) => {
  const parsed = Launch.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Choose a host, repository, safe branch, prompt and stable requestKey", details: parsed.error.issues }, 400);
  const { requestKey, machineId, ...payload } = parsed.data;
  try {
    const placement = await placeTask(c.get("prisma"), c.get("config"), { sourceKey: `launch:${requestKey}`, machineId, repositoryId: payload.repositoryId });
    const delivery = await queueRoutedRequest(c.get("prisma"), { placementId: placement.id, requestKey: `launch:${requestKey}`, kind: "launch", payload });
    return c.json({ placement, delivery }, 202);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskRoutingRoutes.post("/linear-placement", async (c) => {
  const parsed = z.object({ connectionId: Key, issueId: z.string().uuid(), repositoryId: Key, machineId: MachineSchema }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Select the issue, connection, repository and host before launch" }, 400);
  const config = c.get("config");
  if (!config.routing?.ingress || !config.connections[parsed.data.connectionId]) return c.json({ error: "This is not the configured Linear ingress" }, 409);
  try {
    const { connectionId, issueId, ...identity } = parsed.data;
    return c.json({ placement: await placeTask(c.get("prisma"), config, { ...identity, sourceKey: `linear:${connectionId}:${issueId}` }) });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskRoutingRoutes.post("/placements/:placementId/instructions", async (c) => {
  const parsed = z.object({ requestKey: Key, text: z.string().min(1).max(100_000) }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "An instruction and stable requestKey are required" }, 400);
  const prisma = c.get("prisma");
  const placement = await prisma.taskPlacement.findUnique({ where: { id: c.req.param("placementId") } });
  if (!placement) return c.json({ error: "Placement not found" }, 404);
  try {
    return c.json({ delivery: await queueRoutedRequest(prisma, { placementId: placement.id, requestKey: `instruction:${placement.id}:${parsed.data.requestKey}`, kind: "instruction", payload: { text: parsed.data.text } }) }, 202);
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskRoutingRoutes.post("/placements/:placementId/actions", async (c) => {
  const parsed = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("question"), requestKey: Key, questionId: Key, answer: z.string().min(1).max(100_000) }).strict(),
    z.object({ kind: z.literal("automation"), requestKey: Key, action: z.enum(["pause", "resume", "close"]) }).strict(),
  ]).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Choose an owner action and stable requestKey" }, 400);
  const prisma = c.get("prisma");
  const placement = await prisma.taskPlacement.findUnique({ where: { id: c.req.param("placementId") } });
  if (!placement) return c.json({ error: "Placement not found" }, 404);
  const { kind, requestKey, ...payload } = parsed.data;
  try { return c.json({ delivery: await queueRoutedRequest(prisma, { placementId: placement.id, requestKey: `${kind}:${placement.id}:${requestKey}`, kind, payload }) }, 202); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});

taskRoutingRoutes.get("/placements/:placementId", async (c) => {
  const placement = await c.get("prisma").taskPlacement.findUnique({ where: { id: c.req.param("placementId") }, include: { deliveries: { orderBy: { sequence: "asc" } } } });
  if (!placement) return c.json({ error: "Placement not found" }, 404);
  try {
    const request = routingRequest(c.get("config"), async (request) => {
      const { createApp } = await import("../../app.ts");
      return createApp({ config: c.get("config"), prisma: c.get("prisma"), agentRuntime: c.get("agentRuntime"), trustLocal: true }).fetch(request);
    });
    const taskId = await resolvePlacementTask(c.get("prisma"), placement, request);
    if (!taskId) return c.json({ placement, activity: null });
    const response = await request(placement.machineId, "GET", `/api/tasks/${encodeURIComponent(taskId)}/activity`);
    return c.json({ placement: { ...placement, taskId }, activity: response.ok ? await response.json() : null, ownerReachable: response.ok });
  } catch { return c.json({ placement, activity: null, ownerReachable: false }); }
});

taskRoutingRoutes.post("/deliveries/:deliveryId/retry", async (c) => {
  const result = await c.get("prisma").taskDelivery.updateMany({ where: { id: c.req.param("deliveryId"), state: { in: ["failed", "retrying"] } }, data: { state: "queued", retryAt: new Date() } });
  return result.count ? c.json({ queued: true }) : c.json({ error: "Delivery is not retryable" }, 409);
});
