import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createTestDatabase, type TestDatabase } from "../../../../test-support/db.ts";
import { createWebhookReceipt } from "./store.ts";

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
        provider: "linear",
        deliveryId: "shared-delivery-id",
        eventType: "issue",
        trigger: "orchestration",
        resourceId: "ENG-1",
        commentId: null,
        status: "accepted",
      });

    expect(await receipt("linear-one", "connection-one")).not.toBeNull();
    expect(await receipt("linear-one", "connection-one")).toBeNull();
    expect(await receipt("linear-two", "connection-two")).not.toBeNull();
    expect(await database.prisma.webhookReceipt.count()).toBe(2);
  });
});
