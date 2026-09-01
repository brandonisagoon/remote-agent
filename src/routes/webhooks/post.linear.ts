import { Hono } from "hono";

import { MAX_REQUEST_BYTES } from "../../lib/config.ts";
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
        config.webhookSecret,
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
    if (Math.abs(Date.now() - envelope.data.webhookTimestamp) > config.webhookMaxAgeMs) {
      return c.json({ error: "Stale webhook" }, 401);
    }

    const deliveryId = c.req.header("linear-delivery");
    if (!deliveryId) {
      return c.json({ error: "Missing Linear-Delivery header" }, 400);
    }

    const issue = TrackerIssueWebhookSchema.safeParse(parsed);
    if (issue.success) {
      const result = await handleIssueWebhook({
        prisma,
        config,
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
      if (result.kind === IssueWebhookResultKind.Orchestrating) {
        return c.json({ accepted: true, orchestrating: true }, 202);
      }
      if (result.kind === IssueWebhookResultKind.Ending) {
        return c.json({ accepted: true, ending: true }, 202);
      }
      return c.json({ accepted: true, reflecting: true }, 202);
    }

    const reaction = TrackerReactionWebhookSchema.safeParse(parsed);
    if (reaction.success) {
      try {
        const result = await handleReactionWebhook({
          prisma,
          config,
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
        return c.json({ accepted: true, describing: true }, 202);
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
        config,
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
