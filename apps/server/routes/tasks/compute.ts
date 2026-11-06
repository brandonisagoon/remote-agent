import { apiAuthMiddleware } from "../../middleware/api-auth.ts";
import { ComputeConfiguration, configureCompute } from "../../services/tasks/compute-configuration.ts";
import { ComputeEnrollment, computeEnrollmentStatus, enrollCompute } from "../../services/tasks/compute-enrollment.ts";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../middleware/context.ts";
import { bindComputeResource, claimCompute, ComputeCapacityBlocked, ComputeRequest, declineCompute, readComputeCapacity, requestCompute, scheduleComputeOffers } from "../../services/tasks/compute-admission.ts";
import { computeEvidenceState } from "../../services/tasks/compute-observation.ts";
import { computeIdleAttemptStatus } from "../../services/tasks/compute-idle-attempt.ts";
import { developmentProjection } from "../../services/tasks/development-intent.ts";

export const computeRoutes = new Hono<AppEnv>();
computeRoutes.post("/:taskId/compute-configure", async c => {
  const request = ComputeConfiguration.safeParse(await c.req.json());
  if (!request.success) return c.json({ error: "Exact pending configuration and previous allocation are required" }, 400);
  try { return c.json(await configureCompute({ prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId"), request: request.data })); }
  catch { return c.json({ error: "Pending runtime configuration could not be verified; preserve the existing claim and evidence" }, 409); }
});
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
computeRoutes.get("/:taskId/compute-policy", async c => {
  const config = c.get("config"), enabled = config.compute?.enabled === true;
  if (c.req.query("capacity") !== "1") return c.json({ enabled });
  if (!enabled) return c.json({ enabled, capacity: null });
  try {
    const capacity = await readComputeCapacity({ prisma: c.get("prisma"), machineId: config.machine, policy: config.compute!, runtime: c.get("agentRuntime"), taskId: c.req.param("taskId") });
    const prisma = c.get("prisma"), environments = await prisma.computeEnvironment.findMany({ where: { taskId: c.req.param("taskId"), machineId: config.machine }, orderBy: { id: "asc" }, take: 101 });
    const idleConsiderations = environments.length > 100 ? [{ status: "unavailable" as const }] : await Promise.all(environments.map(async environment => {
      try {
        const input = { prisma, config, environmentId: environment.id };
        const observed = await computeEvidenceState(input), projection = await developmentProjection({ ...input, taskId: c.req.param("taskId") });
        const held = projection.developmentBlocked || projection.developmentIntent?.blocked || projection.developmentIntent?.state === "pending" && projection.developmentIntent.reason !== "runtime-suspended";
        return await computeIdleAttemptStatus({ ...input, observed: { ...observed, eligible: observed.eligible && !held }, now: Date.now() });
      } catch { return { environmentId: environment.id, status: "unavailable" as const }; }
    }));
    return c.json({ enabled, capacity, idleConsiderations });
  } catch { return c.json({ error: "Compute capacity could not be observed; existing reservations were preserved" }, 409); }
});
computeRoutes.post("/:taskId/compute-request", async c => {
  const parsed = ComputeRequest.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Use the exact environment, purpose, revision and recipe digest" }, 400);
  const config = c.get("config");
  if (!config.compute?.enabled) return c.json({ enabled: false });
  try {
    const input = { prisma: c.get("prisma"), machineId: config.machine, policy: config.compute, config, runtime: c.get("agentRuntime") };
    const environment = await requestCompute({ ...input, config, taskId: c.req.param("taskId"), request: parsed.data });
    // Selection may wait on slow accounting; it is coalesced and never holds
    // this request (or the adapter's timeout) open.
    void scheduleComputeOffers(input);
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
    return c.json(await claimCompute({ prisma: c.get("prisma"), machineId: config.machine, policy: config.compute, config, runtime: c.get("agentRuntime"), taskId: c.req.param("taskId"), offerId, request }));
  } catch (error) {
    // Accounting is reported with its exact evidence, distinct from an
    // expired or superseded offer; the reservation itself is retained.
    if (error instanceof ComputeCapacityBlocked) return c.json({ error: error.message, code: "compute_capacity_blocked", capacity: { slots: error.capacity.slots, usable: error.capacity.usable, occupied: error.capacity.occupied, unaccounted: error.capacity.unaccounted }, blockers: error.blockers }, 409);
    return c.json({ error: "Compute offer expired, changed or is unavailable; no compute was started", code: "compute_offer_unavailable" }, 409);
  }
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
