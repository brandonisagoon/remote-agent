import { apiAuthMiddleware } from "../../middleware/api-auth.ts";
import { ComputeEnrollment, computeEnrollmentStatus, enrollCompute } from "../../services/tasks/compute-enrollment.ts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../middleware/context.ts";
import { bindComputeResource, claimCompute, ComputeRequest, declineCompute, offerNextCompute, requestCompute } from "../../services/tasks/compute-admission.ts";

export const computeRoutes = new Hono<AppEnv>();
computeRoutes.use("/:taskId/compute-enroll", apiAuthMiddleware());
computeRoutes.get("/:taskId/compute-enroll", async c => {
  const key = ComputeEnrollment.shape.key.safeParse(c.req.query("key"));
  if (!key.success) return c.json({ error: "Exact saved resource key is required" }, 400);
  try { return c.json(await computeEnrollmentStatus({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), key: key.data })); }
  catch { return c.json({ error: "Existing compute enrollment ownership could not be verified" }, 409); }
});
computeRoutes.post("/:taskId/compute-enroll", async c => {
  const request = ComputeEnrollment.safeParse(await c.req.json());
  if (!request.success) return c.json({ error: "Exact owned compute configuration is required" }, 400);
  try { return c.json(await enrollCompute({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), request: request.data })); }
  catch { return c.json({ error: "Compute coverage enrollment could not be verified; existing configuration was preserved" }, 409); }
});
computeRoutes.get("/:taskId/compute-policy", c => c.json({ enabled: c.get("config").compute?.enabled === true }));
computeRoutes.post("/:taskId/compute-request", async c => {
  const parsed = ComputeRequest.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Use the exact environment, purpose, revision and recipe digest" }, 400);
  const config = c.get("config");
  if (!config.compute?.enabled) return c.json({ enabled: false });
  try {
    const input = { prisma: c.get("prisma"), machineId: config.machine, policy: config.compute };
    const environment = await requestCompute({ ...input, config, taskId: c.req.param("taskId"), request: parsed.data });
    await offerNextCompute(input);
    const allocation = await input.prisma.computeOffer.findFirst({ where: { environmentId: environment.id, state: { in: ["claimed", "running", "unknown"] } }, orderBy: { createdAt: "desc" } });
    return c.json({ enabled: true, environment, ...(allocation ? { allocationId: allocation.id } : {}) }, 202);
  } catch { return c.json({ error: "The requested compute environment is unavailable or its ownership changed" }, 409); }
});
computeRoutes.post("/:taskId/compute-claim", async c => {
  const parsed = ComputeRequest.extend({ offerId: z.string().uuid() }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Use the exact compute offer and environment" }, 400);
  const config = c.get("config");
  if (!config.compute?.enabled) return c.json({ error: "Host compute admission is not enabled" }, 409);
  try {
    const { offerId, ...request } = parsed.data;
    return c.json(await claimCompute({ prisma: c.get("prisma"), machineId: config.machine, policy: config.compute, taskId: c.req.param("taskId"), offerId, request }));
  } catch { return c.json({ error: "Compute offer expired, changed or is unavailable; no compute was started", code: "compute_offer_unavailable" }, 409); }
});
computeRoutes.post("/:taskId/compute-decline", async c => {
  const parsed = z.object({ offerId: z.string().uuid() }).strict().safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Use the exact compute offer" }, 400);
  const config = c.get("config");
  if (!config.compute?.enabled) return c.json({ error: "Host compute admission is not enabled" }, 409);
  try { return c.json(await declineCompute({ prisma: c.get("prisma"), machineId: config.machine, policy: config.compute, taskId: c.req.param("taskId"), ...parsed.data })); }
  catch { return c.json({ error: "The compute offer cannot be declined" }, 409); }
});

computeRoutes.post("/:taskId/compute-bind", async c => {
  const parsed = z.object({ offerId: z.string().uuid(), resourceKey: z.string().min(1).max(180) }).strict().safeParse(await c.req.json());
  const config = c.get("config");
  if (!parsed.success || !config.compute?.enabled) return c.json({ error: "Compute binding is unavailable" }, 409);
  try { return c.json(await bindComputeResource({ prisma: c.get("prisma"), machineId: config.machine, policy: config.compute, taskId: c.req.param("taskId"), ...parsed.data })); }
  catch { return c.json({ error: "The exact claimed runtime resource could not be bound" }, 409); }
});
