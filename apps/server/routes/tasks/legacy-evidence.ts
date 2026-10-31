import { z } from "zod";
import { LegacyOriginalWorkAdoption } from "../../services/tasks/legacy-original-work-schema.ts";
import { adoptLegacyOriginalWork } from "../../services/tasks/legacy-original-work.ts";
import { Hono } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import { apiAuthMiddleware } from "../../middleware/api-auth.ts";
import { LegacyEvidenceAdoptionInput, LegacyEvidenceOperationInput } from "../../services/tasks/legacy-evidence-schema.ts";
import { adoptLegacyEvidence, manageLegacyEvidence } from "../../services/tasks/legacy-evidence.ts";

export const legacyEvidenceRoutes = new Hono<AppEnv>();
// Retention adoption is new owner authority, including over trusted local IPC.
legacyEvidenceRoutes.use("/tasks/:taskId/legacy-evidence", apiAuthMiddleware());
legacyEvidenceRoutes.post("/tasks/:taskId/legacy-evidence", async (c) => {
  const parsed = z.union([LegacyEvidenceAdoptionInput, LegacyOriginalWorkAdoption]).safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "Exact prepared evidence and retained archive proof are required", details: parsed.error.issues }, 400);
  try {
    const context = { prisma: c.get("prisma"), config: c.get("config"), taskId: c.req.param("taskId") };
    return c.json("kind" in parsed.data ? await adoptLegacyOriginalWork({ ...context, adoption: parsed.data }) : await adoptLegacyEvidence({ ...context, adoption: parsed.data }));
  }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
legacyEvidenceRoutes.post("/sessions/:sessionId/legacy-evidence", async (c) => {
  const parsed = LegacyEvidenceOperationInput.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "The exact immutable legacy evidence proof is required", details: parsed.error.issues }, 400);
  try { return c.json(await manageLegacyEvidence({ prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId"), operation: parsed.data })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
