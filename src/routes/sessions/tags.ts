import { Hono } from "hono";
import { z } from "zod";

import type { AppEnv } from "../../middleware/context.ts";
import { getRepositoryConfig } from "../../lib/config.ts";
import {
  removeSessionTag,
  setSessionTag,
} from "../../lib/services/sessions/session-metadata.ts";

const SetTagSchema = z.object({
  key: z.string().min(1),
  values: z.array(z.string().min(1)),
  expectedRevision: z.number().int().nonnegative().optional(),
});

const routes = new Hono<AppEnv>();

const sessionInspectionInclude = {
  tags: { orderBy: [{ key: "asc" as const }, { value: "asc" as const }] },
  outgoingRelations: { orderBy: { createdAt: "asc" as const } },
  incomingRelations: { orderBy: { createdAt: "asc" as const } },
  resourceLinks: { orderBy: { createdAt: "asc" as const } },
};

routes.get("/", async (c) => {
  const repositoryId = c.req.query("repositoryId");
  if (repositoryId) getRepositoryConfig(c.get("config"), repositoryId);
  const sessions = await c.get("prisma").runtimeSession.findMany({
    where: {
      ...(repositoryId ? { repositoryId } : {}),
      ...(c.req.query("includeClosed") === "true"
        ? {}
        : { status: { not: "closed" } }),
    },
    include: sessionInspectionInclude,
    orderBy: { updatedAt: "desc" },
  });
  return c.json({ sessions });
});

routes.get("/:sessionId", async (c) => {
  const session = await c.get("prisma").runtimeSession.findUnique({
    where: { id: c.req.param("sessionId") },
    include: sessionInspectionInclude,
  });
  return session
    ? c.json({ session })
    : c.json({ error: "Session not found" }, 404);
});

routes.post("/:sessionId/close", async (c) => {
  const body = await c.req.json().catch(() => ({})) as { reason?: unknown };
  const reason = typeof body.reason === "string" && body.reason.trim()
    ? body.reason.trim()
    : "Closed by operator";
  const sessionId = c.req.param("sessionId");
  const session = await c.get("prisma").runtimeSession.findUnique({
    where: { id: sessionId },
    include: {
      incomingRelations: {
        where: { endedAt: null, relationship: { in: ["spawned-by", "delegates-to"] } },
        include: { source: true },
      },
    },
  });
  if (!session) return c.json({ error: "Session not found" }, 404);
  const ordered = [
    ...session.incomingRelations.map((relation) => relation.source.id),
    session.id,
  ];
  let closed = 0;
  for (const id of [...new Set(ordered)]) {
    const current = await c.get("agentRuntime").getSession(id);
    if (!current || current.status === "closed") continue;
    if (current.status === "active") {
      await c.get("agentRuntime").cancel(id, reason);
    }
    await c.get("agentRuntime").close(id, reason);
    closed += 1;
  }
  return c.json({ sessionId, closed });
});

routes.get("/:sessionId/tags", async (c) => {
  const session = await c.get("prisma").runtimeSession.findUnique({
    where: { id: c.req.param("sessionId") },
    include: { tags: { orderBy: [{ key: "asc" }, { value: "asc" }] } },
  });
  if (!session) return c.json({ error: "Session not found" }, 404);
  const repository = getRepositoryConfig(c.get("config"), session.repositoryId);
  return c.json({
    sessionId: session.id,
    repositoryId: session.repositoryId,
    revision: session.metadataRevision,
    definitions: repository.metadata.tags,
    tags: session.tags.map((tag) => {
      const definition = repository.metadata.tags[tag.key];
      return {
        key: tag.key,
        value: tag.value,
        source: tag.source,
        unlisted:
          !definition ||
          Boolean(definition.options && !definition.options.includes(tag.value)),
      };
    }),
  });
});

routes.put("/:sessionId/tags", async (c) => {
  const parsed = SetTagSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }
  try {
    return c.json(await setSessionTag(c.get("prisma"), c.get("config"), {
      runtimeSessionId: c.req.param("sessionId"),
      key: parsed.data.key,
      values: parsed.data.values,
      source: "operator-api",
      expectedRevision: parsed.data.expectedRevision,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, message.includes("revision conflict") ? 409 : 400);
  }
});

routes.delete("/:sessionId/tags/:key", async (c) => {
  const expected = c.req.query("expectedRevision");
  const expectedRevision = expected === undefined ? undefined : Number(expected);
  if (expected !== undefined && (!Number.isInteger(expectedRevision) || expectedRevision! < 0)) {
    return c.json({ error: "expectedRevision must be a non-negative integer" }, 400);
  }
  try {
    return c.json(await removeSessionTag(c.get("prisma"), c.get("config"), {
      runtimeSessionId: c.req.param("sessionId"),
      key: c.req.param("key"),
      value: c.req.query("value"),
      source: "operator-api",
      expectedRevision,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return c.json({ error: message }, message.includes("revision conflict") ? 409 : 400);
  }
});

export default routes;
