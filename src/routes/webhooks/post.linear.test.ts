import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { createApp } from "../../app.ts";
import type { ServerConfig } from "../../lib/config.ts";
import type { PrismaClient } from "../../generated/prisma/client.ts";
import { testConfig } from "../../test-support/config.ts";
import { createTestDatabase, type TestDatabase } from "../../test-support/db.ts";

const SECRET = "test-webhook-secret";
const AGENT_USER_ID = "11111111-2222-3333-4444-555555555555";
const originalFetch = globalThis.fetch;

const config: ServerConfig = testConfig({
  webhookSecret: SECRET,
  agentUserId: AGENT_USER_ID,
});

let db: TestDatabase;
let prisma: PrismaClient;

beforeEach(async () => {
  db = await createTestDatabase();
  prisma = db.prisma;
  globalThis.fetch = (async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { query: string };
    if (
      body.query.includes("AgentIssueById") ||
      body.query.includes("CubeIssueWithAgentIssues")
    ) {
      return Response.json({ data: { issue: null } });
    }
    if (body.query.includes("CreateReaction")) {
      return Response.json({
        data: { reactionCreate: { success: true } },
      });
    }
    return Response.json({ data: {} });
  }) as typeof fetch;
});

afterEach(async () => {
  await Bun.sleep(10);
  globalThis.fetch = originalFetch;
  await db.cleanup();
});

function commentPayload(overrides: Record<string, unknown> = {}) {
  return {
    type: "Comment",
    action: "create",
    webhookTimestamp: Date.now(),
    organizationId: "org-1",
    data: {
      id: "comment-1",
      body: `Hey @cubic-agent please check this`,
      issueId: "issue-1",
      parentId: null as string | null,
      userId: "user-brandon",
      user: { id: "user-brandon", name: "Brandon" },
      issue: { id: "issue-1", identifier: "CUBE-2600", title: "Remote agent" },
    },
    ...overrides,
  };
}

function issuePayload({
  identifier = "CUBE-2774",
  state = "Planning",
  team = "CUBE",
  includePreviousState = true,
  updatedFrom,
}: {
  identifier?: string;
  state?: string;
  team?: string;
  includePreviousState?: boolean;
  updatedFrom?: { stateId?: string | null } | null;
} = {}) {
  return {
    type: "Issue",
    action: "update",
    webhookTimestamp: Date.now(),
    data: {
      id: "issue-1",
      identifier,
      state: { name: state, type: "unstarted" },
      team: { key: team },
    },
    ...(includePreviousState
      ? {
          updatedFrom:
            updatedFrom === undefined
              ? { stateId: "previous-state-id" }
              : updatedFrom,
        }
      : {}),
  };
}

function agentIssuePayload(
  overrides: Parameters<typeof issuePayload>[0] = {},
) {
  return issuePayload({
    identifier: "AGENT-1",
    state: "End",
    team: "AGENT",
    ...overrides,
  });
}

function reactionPayload({
  action = "create",
  emoji = "pencil2",
  identifier = "CUBE-2804",
  userId = "user-brandon",
  target = "issue",
}: {
  action?: string;
  emoji?: string;
  identifier?: string;
  userId?: string;
  target?: "issue" | "comment";
} = {}) {
  const targetData =
    target === "issue"
      ? {
          issueId: "issue-1",
          issue: { id: "issue-1", identifier, title: "Describe me" },
        }
      : {
          commentId: "comment-1",
          comment: { id: "comment-1" },
        };
  return {
    type: "Reaction",
    action,
    webhookTimestamp: Date.now(),
    organizationId: "org-1",
    data: {
      id: "reaction-1",
      emoji,
      userId,
      user: { id: userId, name: "Brandon" },
      ...targetData,
    },
  };
}

function post(
  body: unknown,
  {
    secret = SECRET,
    deliveryId = crypto.randomUUID(),
    signature,
  }: { secret?: string; deliveryId?: string | null; signature?: string } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "linear-signature":
      signature ?? createHmac("sha256", secret).update(raw).digest("hex"),
  };
  if (deliveryId) headers["linear-delivery"] = deliveryId;

  return createApp({ config, prisma }).request("/webhooks/linear", {
    method: "POST",
    headers,
    body: raw,
  });
}

describe("signature verification", () => {
  test("rejects a wrong secret before doing any work", async () => {
    const response = await post(commentPayload(), { secret: "wrong" });

    expect(response.status).toBe(401);
    expect(await prisma.linearWebhookReceipt.count()).toBe(0);
  });

  test("rejects a missing signature", async () => {
    const raw = JSON.stringify(commentPayload());
    const response = await createApp({ config, prisma }).request(
      "/webhooks/linear",
      {
        method: "POST",
        headers: { "linear-delivery": "d1" },
        body: raw,
      },
    );

    expect(response.status).toBe(401);
  });

  test("rejects a body altered after signing", async () => {
    const original = JSON.stringify(commentPayload());
    const signature = createHmac("sha256", SECRET).update(original).digest("hex");

    const response = await post(`${original} `, { signature });
    expect(response.status).toBe(401);
  });
});

describe("replay window", () => {
  test("rejects a stale timestamp", async () => {
    const response = await post(
      commentPayload({ webhookTimestamp: Date.now() - 120_000 }),
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "Stale webhook" });
  });

  test("rejects a future-dated timestamp too", async () => {
    const response = await post(
      commentPayload({ webhookTimestamp: Date.now() + 120_000 }),
    );

    expect(response.status).toBe(401);
  });

  test("accepts one inside the window", async () => {
    const response = await post(
      commentPayload({ webhookTimestamp: Date.now() - 5_000 }),
    );

    expect(response.status).toBe(202);
  });
});

describe("delivery deduplication", () => {
  test("the same Linear-Delivery id is only acted on once", async () => {
    const deliveryId = "delivery-abc";
    const payload = commentPayload();

    const first = await post(payload, { deliveryId });
    const second = await post(payload, { deliveryId });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(1);
  });

  test("distinct deliveries are both recorded", async () => {
    await post(commentPayload(), { deliveryId: "d-1" });
    await post(commentPayload(), { deliveryId: "d-2" });

    expect(await prisma.linearWebhookReceipt.count()).toBe(2);
  });

  test("requires the Linear-Delivery header", async () => {
    const response = await post(commentPayload(), { deliveryId: null });
    expect(response.status).toBe(400);
  });
});

describe("description reaction trigger", () => {
  test.each(["pencil2", "✏️", "✏"])(
    "accepts the configured pencil emoji form %s",
    async (emoji) => {
      const response = await post(reactionPayload({ emoji }));

      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        accepted: true,
        describing: true,
      });
      expect(await prisma.linearWebhookReceipt.findFirst()).toMatchObject({
        eventType: "reaction",
        trigger: "describe",
        cubeIssueIdentifier: "CUBE-2804",
        status: "accepted",
      });
    },
  );

  test("deduplicates a replayed reaction delivery", async () => {
    const payload = reactionPayload();
    const first = await post(payload, { deliveryId: "reaction-delivery" });
    const second = await post(payload, { deliveryId: "reaction-delivery" });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(1);
  });

  test.each([
    ["remove action", { action: "remove" }, "not_create"],
    ["comment target", { target: "comment" as const }, "comment_target"],
    [
      "self-authored memo",
      { userId: AGENT_USER_ID, emoji: "memo" },
      "self_authored",
    ],
    ["different emoji", { emoji: "thumbsup" }, "emoji_mismatch"],
  ])("ignores %s without a receipt", async (_name, overrides, reason) => {
    const response = await post(reactionPayload(overrides));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true, reason });
    expect(await prisma.linearWebhookReceipt.count()).toBe(0);
  });

  test("records an ignored receipt for an Agents issue", async () => {
    const response = await post(
      reactionPayload({ identifier: "AGENT-42" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ignored: true,
      reason: "agent_team_issue",
    });
    expect(await prisma.linearWebhookReceipt.findFirst()).toMatchObject({
      eventType: "reaction",
      trigger: "describe",
      cubeIssueIdentifier: "AGENT-42",
      status: "ignored",
      detail: "agent_team_issue",
    });
  });

  test("logs and safely ignores an unrecognized Reaction shape", async () => {
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    const payload = reactionPayload();
    delete (payload.data as { emoji?: string }).emoji;

    const response = await post(payload);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(0);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("linear_reaction_schema_mismatch"),
    );
    warning.mockRestore();
  });
});

describe("end trigger", () => {
  test("accepts an Agents issue transition into End", async () => {
    const response = await post(agentIssuePayload());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true, ending: true });
    const receipt = await prisma.linearWebhookReceipt.findFirst();
    expect(receipt).toMatchObject({
      eventType: "issue",
      trigger: "end",
      cubeIssueIdentifier: "AGENT-1",
      status: "accepted",
    });
  });

  test("deduplicates repeated End deliveries", async () => {
    const payload = agentIssuePayload();
    const first = await post(payload, { deliveryId: "end-delivery" });
    const second = await post(payload, { deliveryId: "end-delivery" });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(1);
  });

  test("ignores other Agents workflow updates", async () => {
    const response = await post(agentIssuePayload({ state: "Connected" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(0);
  });

  test("ignores End payloads without a state transition", async () => {
    const response = await post(agentIssuePayload({ updatedFrom: null }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(0);
  });

  test("does not treat a product issue state named End as a session trigger", async () => {
    const response = await post(
      issuePayload({ identifier: "CUBE-2801", state: "End" }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(0);
  });

  test("keeps the product reflection trigger unchanged", async () => {
    const response = await post(
      issuePayload({
        identifier: "CUBE-2801",
        team: "CUBE",
        state: "Pull Request",
      }),
    );

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      reflecting: true,
    });
    const receipt = await prisma.linearWebhookReceipt.findFirst();
    expect(receipt).toMatchObject({ trigger: "reflection" });
  });
});

describe("event filtering", () => {
  test("ignores non-Comment event types without recording them", async () => {
    const response = await post({
      type: "Issue",
      action: "update",
      webhookTimestamp: Date.now(),
      data: { id: "issue-1" },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(0);
  });

  test("ignores comment removal", async () => {
    const response = await post(commentPayload({ action: "remove" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
  });

  test("records but ignores a comment with no mention", async () => {
    const payload = commentPayload();
    payload.data.body = "just a normal comment";

    const response = await post(payload);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });

    const row = await prisma.linearWebhookReceipt.findFirst();
    expect(row?.status).toBe("ignored");
    expect(row?.detail).toBe("no_agent_mention");
  });

  test("ignores a mention the agent wrote itself, preventing a loop", async () => {
    const payload = commentPayload();
    payload.data.userId = AGENT_USER_ID;
    payload.data.user = { id: AGENT_USER_ID, name: "Cubic Agent" };
    payload.data.body = `@cubic-agent ${AGENT_USER_ID} replying to myself`;

    const response = await post(payload);

    expect(response.status).toBe(200);
    const row = await prisma.linearWebhookReceipt.findFirst();
    expect(row?.status).toBe("ignored");
    expect(row?.detail).toBe("self_authored");
  });

  test("accepts a mention and stores it pending routing", async () => {
    const response = await post(commentPayload());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      cubeIssueIdentifier: "CUBE-2600",
    });

    const row = await prisma.linearWebhookReceipt.findFirst();
    expect(row?.status).toBe("accepted");
    expect(row?.cubeIssueIdentifier).toBe("CUBE-2600");
    expect(row?.eventType).toBe("comment");
    expect(row?.trigger).toBe("mention");
  });

  test("accepts a threaded mention with its parent id", async () => {
    const payload = commentPayload();
    payload.data.parentId = "root-1";

    const response = await post(payload);

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      cubeIssueIdentifier: "CUBE-2600",
    });
  });

  test("a comment on an unregistered issue is still recorded", async () => {
    // Nullable FK on purpose — otherwise the row could not be written and the
    // retry would be delivered again forever.
    const response = await post(commentPayload());
    expect(response.status).toBe(202);

    const row = await prisma.linearWebhookReceipt.findFirst();
    expect(row?.cubeIssueIdentifier).toBe("CUBE-2600");
    expect(await prisma.linearWebhookReceipt.count()).toBe(1);
  });
});

describe("issue state changes", () => {
  test("accepts Planning transitions for orchestration", async () => {
    const response = await post(issuePayload(), {
      deliveryId: "planning-transition",
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      orchestrating: true,
    });
    const receipt = await prisma.linearWebhookReceipt.findFirstOrThrow();
    expect(receipt.eventType).toBe("issue");
    expect(receipt.trigger).toBe("orchestration");
  });

  test("ignores issue updates without a state transition", async () => {
    const response = await post(
      issuePayload({ includePreviousState: false }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(0);
  });

  test("ignores Agents-team issue transitions", async () => {
    const response = await post(issuePayload({ team: "AGENT" }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(0);
  });

  test("keeps Pull Request reflection behavior", async () => {
    const response = await post(issuePayload({ state: "Pull Request" }), {
      deliveryId: "reflection-transition",
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      accepted: true,
      reflecting: true,
    });
    const receipt = await prisma.linearWebhookReceipt.findFirstOrThrow();
    expect(receipt.trigger).toBe("reflection");
  });

  test("deduplicates repeated Planning deliveries", async () => {
    const payload = issuePayload();
    const first = await post(payload, { deliveryId: "planning-duplicate" });
    const second = await post(payload, { deliveryId: "planning-duplicate" });

    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });
    expect(await prisma.linearWebhookReceipt.count()).toBe(1);
  });
});

describe("malformed input", () => {
  test("rejects invalid JSON with 400, not 500", async () => {
    const response = await post("{not json");
    expect(response.status).toBe(400);
  });

  test("rejects an unrecognized envelope", async () => {
    const response = await post({ hello: "world" });
    expect(response.status).toBe(400);
  });
});
