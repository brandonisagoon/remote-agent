import { createHash } from "node:crypto";
import { NativeLaunchGrant, nativeLaunchControl, grantNativeLaunch, bindNativeLaunchSession, assertNativeLaunch } from "../../services/launches/native-takeover.ts";
import { verifyBearerToken } from "../../security.ts";
import { queueInstruction, deliverInstructions } from "../../services/sessions/inbox.ts";
import path from "node:path";

import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../middleware/context.ts";
import {
  getLinearConnection,
  getRepositoryConfig,
  resolveRepositoryForCwd,
  scopeConfig,
} from "../../../../lib/config.ts";
import { getMachine, MachineSchema } from "../../../../lib/machines/index.ts";
import { spawnAgentThread } from "../../services/launches/index.ts";
import {
  ProviderIdSchema,
  SourceIssueIdentifierSchema,
  SessionLifecycleSchema,
  SessionRoleSchema,
} from "../../../../types/sessions/index.ts";

const LaunchSchema = z.object({
  nativeGrant: NativeLaunchGrant.optional(),
  issueIdentifier: SourceIssueIdentifierSchema,
  harness: ProviderIdSchema,
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
  repositoryId: z.string().min(1).max(128).optional(),
  connectionId: z.string().min(1).max(128).optional(),
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
  let repository;
  let connectionId: string;
  try {
    repository = parsed.data.repositoryId
      ? getRepositoryConfig(config, parsed.data.repositoryId)
      : resolveRepositoryForCwd(config, parsed.data.worktreePath);
    const cwdRepository = resolveRepositoryForCwd(config, parsed.data.worktreePath);
    if (cwdRepository.id !== repository.id) {
      return c.json({ error: "worktreePath does not belong to repositoryId" }, 409);
    }
    connectionId = parsed.data.connectionId ?? config.activeConnectionId;
    getLinearConnection(config, connectionId);
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
  const scopedConfig = scopeConfig(config, {
    connectionId,
    repositoryId: repository.id,
  });
  try {
    getMachine({ id: parsed.data.machine });
  } catch {
    return c.json(
      { error: `No execution target is configured for ${parsed.data.machine}` },
      409,
    );
  }

  try {
    const { harness, nativeGrant, ...rest } = parsed.data;
    const prisma = c.get("prisma"), runtime = c.get("agentRuntime");
    const source = { connectionId, repositoryId: repository.id, issueIdentifier: parsed.data.issueIdentifier };
    const control = await nativeLaunchControl(prisma, source);
    if (control || nativeGrant) {
      if (!verifyBearerToken(c.req.header("authorization") ?? null, config.apiKey)) return c.json({ error: "An explicit owner launch requires the owner bearer" }, 401);
      if (rest.machine !== config.machine) return c.json({ error: "Use the source owning host for native handoff" }, 409);
      if (!nativeGrant || !rest.launchKey || rest.role !== "primary") return c.json({ error: "Use the inspected native revision and a stable owner launchKey" }, 409);
      const tasks = await prisma.remoteTask.findMany({ where: { ...source, machineId: config.machine, phase: { not: "closed" } } });
      if (tasks.length > 1) return c.json({ error: "Multiple original families require explicit reconciliation" }, 409);
      const task = tasks[0];
      if (task && (!task.primarySessionId || task.worktreePath !== rest.worktreePath || rest.branchName && task.branchName !== rest.branchName)) return c.json({ error: "Resume the exact original family and worktree" }, 409);
      await grantNativeLaunch({ prisma, config, runtime }, { ...source, issueId: nativeGrant.issueId }, rest.launchKey, nativeGrant.expectedRevision, createHash("sha256").update(JSON.stringify(parsed.data)).digest("hex"));
      if (task) {
        await bindNativeLaunchSession(prisma, source, rest.launchKey, task.primarySessionId!);
        await prisma.$transaction(async tx => {
          await assertNativeLaunch(tx, source, rest.launchKey!);
          const changed = await tx.remoteTask.updateMany({ where: { id: task.id, primarySessionId: task.primarySessionId, worktreePath: task.worktreePath, phase: { not: "closed" } }, data: { ownerPaused: false } });
          if (!changed.count) throw new Error("Original family changed before owner continuation");
          await queueInstruction(tx, { sessionId: task.primarySessionId!, requestId: `native-return:${rest.launchKey}`, text: rest.prompt });
        });
        await deliverInstructions(prisma, runtime);
        return c.json({ sessionId: task.primarySessionId, taskId: task.id, resumed: true, machine: task.machineId, repositoryId: task.repositoryId }, 200);
      }
    }
    const launched = await spawnAgentThread({
      ...rest,
      provider: harness,
      launchKey:
        parsed.data.launchKey ??
        `api:${parsed.data.issueIdentifier}:${parsed.data.role}:${parsed.data.branchName ?? parsed.data.worktreePath}`,
      config: scopedConfig,
      prisma: c.get("prisma"),
      agentRuntime: c.get("agentRuntime"),
    });
    return c.json(
      {
        sessionId: launched.session.id,
        machine: parsed.data.machine,
        acpxRecordId: launched.session.acpxRecordId,
        repositoryId: repository.id,
      },
      201,
    );
  } catch (error) {
    if (parsed.data.nativeGrant) return c.json({ error: error instanceof Error ? error.message : String(error) }, 409);
    throw error;
  }
});

export default route;
