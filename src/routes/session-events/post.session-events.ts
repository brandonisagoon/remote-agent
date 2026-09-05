import { Hono } from "hono";

import type { AppEnv } from "../../middleware/context.ts";
import {
  endOneShotSession,
  endWorktreeSessions,
  SessionLifecycleEventSchema,
  upsertAgentIssueFromEvent,
} from "../../lib/services/sessions/index.ts";

const route = new Hono<AppEnv>();

route.post("/", async (c) => {
  const parsed = SessionLifecycleEventSchema.safeParse(
    await c.req.json().catch(() => null),
  );
  if (!parsed.success) {
    return c.json({ error: "Invalid body", issues: parsed.error.issues }, 400);
  }

  try {
    if (parsed.data.type === "worktree.ended") {
      const ended = await endWorktreeSessions(
        c.get("config"),
        parsed.data,
        c.get("prisma"),
      );
      return c.json({ ended }, 200);
    }
    const config = c.get("config");
    const issue = await upsertAgentIssueFromEvent(
      config,
      parsed.data,
      c.get("prisma"),
      {},
    );
    if (!issue) {
      return c.json({ ignored: true }, 200);
    }
    if (
      (parsed.data.type === "workflow.ended" ||
        parsed.data.type === "session.ended") &&
      parsed.data.runtime.lifecycle === "one-shot" &&
      parsed.data.runtime.parentSessionId == null
    ) {
      await endOneShotSession(config, issue, c.get("agentRuntime"), {
        kill: parsed.data.runtime.machine === config.machine,
      });
    }
    return c.json(
      {
        agentIssue: {
          id: issue.id,
          identifier: issue.identifier,
          status: issue.state.name,
        },
      },
      200,
    );
  } catch (error) {
    console.error("Failed to persist agent issue:", error);
    return c.json(
      {
        error: "Agent issue persistence failed",
        detail: error instanceof Error ? error.message : String(error),
      },
      502,
    );
  }
});

export default route;
