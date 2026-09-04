import { Hono } from "hono";

import { MAX_REQUEST_BYTES } from "../../lib/config.ts";
import {
  getWebhookConfig,
  routeWebhookRepository,
  scopeConfig,
} from "../../lib/config.ts";
import {
  IssueWebhookResultKind,
  TrackerCommentWebhookSchema,
  TrackerIssueWebhookSchema,
  TrackerReactionWebhookSchema,
  TrackerWebhookEnvelopeSchema,
  ReactionWebhookResultKind,
  verifyTrackerWebhookSignature,
  WebhookReceiptError,
  handleCommentWebhook,
  handleIssueWebhook,
  handleReactionWebhook,
} from "../../lib/integrations/tracker/index.ts";
import type { AppEnv } from "../../middleware/context.ts";

const route = new Hono<AppEnv>();

route.post("/", async (c) => {
    const config = c.get("config");
    const webhookId = c.req.param("webhookId");
    if (!webhookId) return c.json({ error: "Unknown webhook" }, 404);
    let webhookConfig;
    try {
      webhookConfig = getWebhookConfig(config, webhookId);
    } catch {
      return c.json({ error: "Unknown webhook" }, 404);
    }
    const prisma = c.get("prisma");
    const agentRuntime = c.get("agentRuntime");
    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (declaredLength > MAX_REQUEST_BYTES) {
      return c.json({ error: "Payload Too Large" }, 413);
    }

    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody) > MAX_REQUEST_BYTES) {
      return c.json({ error: "Payload Too Large" }, 413);
    }
    if (
      !verifyTrackerWebhookSignature(
        rawBody,
        c.req.header("linear-signature") ?? null,
        webhookConfig.webhookSecret,
      )
    ) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    const envelope = TrackerWebhookEnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      return c.json({ error: "Unrecognized webhook envelope" }, 400);
    }
    if (Math.abs(Date.now() - envelope.data.webhookTimestamp) > webhookConfig.webhookMaxAgeMs) {
      return c.json({ error: "Stale webhook" }, 401);
    }

    const record = parsed as Record<string, any>;
    const data = record.data && typeof record.data === "object" ? record.data : {};
    const issueRoutingData = data.issue && typeof data.issue === "object" ? data.issue : {};
    const team = data.team && typeof data.team === "object"
      ? data.team
      : issueRoutingData.team && typeof issueRoutingData.team === "object"
        ? issueRoutingData.team
        : {};
    const project = data.project && typeof data.project === "object"
      ? data.project
      : issueRoutingData.project && typeof issueRoutingData.project === "object"
        ? issueRoutingData.project
        : {};
    let repository;
    try {
      repository = routeWebhookRepository(config, webhookId, {
        "linear.organizationId": record.organizationId,
        "linear.teamId": data.teamId ?? issueRoutingData.teamId ?? team.id,
        "linear.teamKey": team.key,
        "linear.projectId": data.projectId ?? issueRoutingData.projectId ?? project.id,
      });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        409,
      );
    }
    const scopedConfig = scopeConfig(config, {
      connectionId: webhookConfig.connectionId,
      repositoryId: repository.id,
      webhookId,
    });

    const deliveryId = c.req.header("linear-delivery");
    if (!deliveryId) {
      return c.json({ error: "Missing Linear-Delivery header" }, 400);
    }

    const issue = TrackerIssueWebhookSchema.safeParse(parsed);
    if (issue.success) {
      const result = await handleIssueWebhook({
        prisma,
        config: scopedConfig,
        agentRuntime,
        deliveryId,
        webhook: issue.data,
      });
      if (result.kind === IssueWebhookResultKind.Ignored) {
        return c.json({ accepted: true, ignored: true }, 200);
      }
      if (result.kind === IssueWebhookResultKind.Duplicate) {
        return c.json({ accepted: true, duplicate: true }, 200);
      }
      if (result.kind === IssueWebhookResultKind.Ending) {
        return c.json({ accepted: true, ending: true }, 202);
      }
      return c.json({ accepted: true, workflows: result.workflowIds ?? [] }, 202);
    }

    const reaction = TrackerReactionWebhookSchema.safeParse(parsed);
    if (reaction.success) {
      try {
        const result = await handleReactionWebhook({
          prisma,
          config: scopedConfig,
          agentRuntime,
          deliveryId,
          webhook: reaction.data,
        });
        if (result.kind === ReactionWebhookResultKind.Duplicate) {
          return c.json({ accepted: true, duplicate: true }, 200);
        }
        if (result.kind === ReactionWebhookResultKind.Ignored) {
          return c.json(
            {
              accepted: true,
              ignored: true,
              reason: result.reason,
            },
            200,
          );
        }
        return c.json(
          { accepted: true, workflows: "workflowIds" in result ? result.workflowIds : [] },
          202,
        );
      } catch (error) {
        if (error instanceof WebhookReceiptError) {
          return c.json({ error: "Failed to record delivery" }, 500);
        }
        throw error;
      }
    }
    if (envelope.data.type === "Reaction") {
      const data =
        typeof parsed === "object" && parsed !== null && "data" in parsed
          ? (parsed as { data?: unknown }).data
          : null;
      console.warn(
        JSON.stringify({
          event: "linear_reaction_schema_mismatch",
          issues: reaction.error.issues,
          dataKeys:
            typeof data === "object" && data !== null
              ? Object.keys(data)
              : [],
        }),
      );
    }

    const comment = TrackerCommentWebhookSchema.safeParse(parsed);
    if (!comment.success) {
      return c.json({ accepted: true, ignored: true }, 200);
    }

    try {
      const result = await handleCommentWebhook({
        prisma,
        config: scopedConfig,
        agentRuntime,
        deliveryId,
        webhook: comment.data,
      });

      if (result.kind === "duplicate") {
        return c.json({ accepted: true, duplicate: true }, 200);
      }
      if (result.kind === "ignored") {
        return c.json(
          {
            accepted: true,
            ignored: true,
            reason: result.reason,
          },
          200,
        );
      }
      return c.json(
        {
          accepted: true,
          deliveryId: result.deliveryId,
          sourceIssueIdentifier: result.sourceIssueIdentifier,
        },
        202,
      );
    } catch (error) {
      if (error instanceof WebhookReceiptError) {
        return c.json({ error: "Failed to record delivery" }, 500);
      }
      throw error;
    }
});

export default route;
