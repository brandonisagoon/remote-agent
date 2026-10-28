import { Hono } from "hono";
import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { AppEnv } from "../../middleware/context.ts";
import { createControlDiagnostics } from "../../services/diagnostics/control.ts";

// Shared across the network and trusted local apps for the same database client.
const diagnostics = new WeakMap<PrismaClient, ReturnType<typeof createControlDiagnostics>>();
export const diagnosticsRoutes = new Hono<AppEnv>();

diagnosticsRoutes.get("/control", async (c) => {
  const prisma = c.get("prisma");
  let sample = diagnostics.get(prisma);
  if (!sample) {
    sample = createControlDiagnostics({ probeStore: () => prisma.$queryRaw`SELECT 1` });
    diagnostics.set(prisma, sample);
  }
  const result = await sample();
  c.header("Server-Timing", `diagnostics;dur=${result.server.elapsedMs.toFixed(2)}`);
  return c.json(result);
});
