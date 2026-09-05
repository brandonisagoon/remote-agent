import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createWebhookReceipt } from "./receipt-store.ts";

describe("webhook-scoped delivery receipts", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
  });

  afterEach(async () => {
    await database.cleanup();
  });

  test("deduplicates within a webhook without colliding across connections", async () => {
    const receipt = (webhookId: string, connectionId: string) =>
      createWebhookReceipt(database.prisma, {
        webhookId,
        connectionId,
        repositoryId: "repository-one",
        linearDeliveryId: "shared-delivery-id",
        eventType: "issue",
        trigger: "orchestration",
        sourceIssueIdentifier: "ENG-1",
        sourceCommentId: null,
        status: "accepted",
      });

    expect(await receipt("linear-one", "connection-one")).not.toBeNull();
    expect(await receipt("linear-one", "connection-one")).toBeNull();
    expect(await receipt("linear-two", "connection-two")).not.toBeNull();
    expect(await database.prisma.linearWebhookReceipt.count()).toBe(2);
  });
});
