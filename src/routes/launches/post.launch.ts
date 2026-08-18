import path from "node:path";

import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../middleware/context.ts";
import { MachineSchema } from "../../lib/machines/index.ts";
import {
  ModelResolutionError,
  spawnAgentThread,
} from "../../lib/services/launches/index.ts";
import {
  HarnessSchema,
  SessionLifecycleSchema,
  SessionRoleSchema,
} from "../../types/sessions/index.ts";

const LaunchSchema = z.object({
  issueIdentifier: z.string().regex(/^CUBE-\d+$/),
  harness: HarnessSchema,
  model: z.string().min(1).max(128).optional(),
  prompt: z.string().min(1).max(100_000),
  machine: MachineSchema,
  worktreePath: z.string().min(1).max(4096),
  branchName: z.string().min(1).max(512).nullish(),
  lifecycle: SessionLifecycleSchema,
  role: SessionRoleSchema,
  title: z.string().min(1).max(512).optional(),
  parentThreadId: z.string().min(1).max(256).optional(),
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
  if (!config.bbHostIds[parsed.data.machine]) {
    return c.json(
      { error: `No bb host is configured for ${parsed.data.machine}` },
      409,
    );
  }

  try {
    const launched = await spawnAgentThread({
      ...parsed.data,
      config,
      prisma: c.get("prisma"),
      bbClient: c.get("bbClient"),
    });
    return c.json(
      {
        threadId: launched.thread.id,
        machine: parsed.data.machine,
        environmentId: launched.thread.environmentId,
        agentIssueIdentifier: launched.agentIssue?.identifier ?? null,
      },
      201,
    );
  } catch (error) {
    if (error instanceof ModelResolutionError) {
      return c.json(
        {
          error: error.message,
          requestedModel: error.requestedModel,
          availableModels: error.availableModelIds,
        },
        422,
      );
    }
    throw error;
  }
});

export default route;
