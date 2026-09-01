import path from "node:path";

import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../middleware/context.ts";
import { getMachine, MachineSchema } from "../../lib/machines/index.ts";
import { spawnAgentThread } from "../../lib/services/launches/index.ts";
import {
  HarnessSchema,
  SourceIssueIdentifierSchema,
  SessionLifecycleSchema,
  SessionRoleSchema,
} from "../../types/sessions/index.ts";

const LaunchSchema = z.object({
  issueIdentifier: SourceIssueIdentifierSchema,
  harness: HarnessSchema,
  model: z.string().min(1).max(128).optional(),
  prompt: z.string().min(1).max(100_000),
  machine: MachineSchema,
  worktreePath: z.string().min(1).max(4096),
  branchName: z.string().min(1).max(512).nullish(),
  lifecycle: SessionLifecycleSchema,
  role: SessionRoleSchema,
  title: z.string().min(1).max(512).optional(),
  parentSessionId: z.string().min(1).max(256).optional(),
  launchKey: z.string().min(1).max(512).optional(),
});

const route = new Hono<AppEnv>();

route.post("/", async (c) => {
  const parsed = LaunchSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  if (!path.isAbsolute(parsed.data.worktreePath)) {
    return c.json({ error: "worktreePath must be absolute" }, 400);
  }

  const config = c.get("config");
  try {
    getMachine({ id: parsed.data.machine });
  } catch {
    return c.json(
      { error: `No execution target is configured for ${parsed.data.machine}` },
      409,
    );
  }

  try {
    const launched = await spawnAgentThread({
      ...parsed.data,
      launchKey:
        parsed.data.launchKey ??
        `api:${parsed.data.issueIdentifier}:${parsed.data.role}:${parsed.data.branchName ?? parsed.data.worktreePath}`,
      config,
      prisma: c.get("prisma"),
      agentRuntime: c.get("agentRuntime"),
    });
    return c.json(
      {
        sessionId: launched.session.id,
        machine: parsed.data.machine,
        acpxRecordId: launched.session.acpxRecordId,
        agentIssueIdentifier: launched.agentIssue?.identifier ?? null,
      },
      201,
    );
  } catch (error) {
    throw error;
  }
});

export default route;
