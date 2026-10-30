import { Hono } from "hono";
import type { AppEnv } from "../../middleware/context.ts";
import { ArchiveRetentionCheck } from "../../services/tasks/archive-retention-schema.ts";
import { verifyArchiveRetention } from "../../services/tasks/archive-retention.ts";

export const archiveRetentionRoutes = new Hono<AppEnv>();
// Read-only verification of a server-recorded preparation supplement. The
// caller cannot supply paths, new archive identities, or a replacement proof.
archiveRetentionRoutes.post("/sessions/:sessionId/archive-retention", async c => {
  const parsed = ArchiveRetentionCheck.safeParse(await c.req.json());
  if (!parsed.success) return c.json({ error: "The exact recorded archive retention proof is required", details: parsed.error.issues }, 400);
  try { return c.json(await verifyArchiveRetention({ prisma: c.get("prisma"), config: c.get("config"), sessionId: c.req.param("sessionId"), check: parsed.data })); }
  catch (error) { return c.json({ error: error instanceof Error ? error.message : String(error) }, 409); }
});
