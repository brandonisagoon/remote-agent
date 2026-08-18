import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "../../app.ts";
import type { ServerConfig } from "../../lib/config.ts";
import type { PrismaClient } from "../../generated/prisma/client.ts";
import { testConfig } from "../../test-support/config.ts";
import { createTestDatabase, type TestDatabase } from "../../test-support/db.ts";

const GH_SECRET = "test-github-secret";

const config: ServerConfig = testConfig({
  githubWebhookSecret: GH_SECRET,
  // Intentionally absent: proves a push fails loudly rather than silently
  // doing nothing when the deploy script is not installed.
  deployScript: "/nonexistent/deploy.sh",
});

let db: TestDatabase;
let prisma: PrismaClient;

beforeAll(async () => {
  db = await createTestDatabase();
  prisma = db.prisma;
});

afterAll(async () => {
  await db.cleanup();
});

function post(
  body: unknown,
  { event = "push", secret = GH_SECRET }: { event?: string; secret?: string } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return createApp({ config, prisma }).request("/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
    },
    body: raw,
  });
}

describe("signature verification", () => {
  test("rejects a wrong secret", async () => {
    const response = await post({ ref: "refs/heads/main" }, { secret: "wrong" });
    expect(response.status).toBe(401);
  });

  test("rejects a missing signature header", async () => {
    const response = await createApp({ config, prisma }).request("/webhooks/github", {
      method: "POST",
      headers: { "x-github-event": "push" },
      body: JSON.stringify({ ref: "refs/heads/main" }),
    });
    expect(response.status).toBe(401);
  });

  test("rejects a signature without the sha256= prefix", async () => {
    const raw = JSON.stringify({ ref: "refs/heads/main" });
    const response = await createApp({ config, prisma }).request("/webhooks/github", {
      method: "POST",
      headers: {
        "x-github-event": "push",
        "x-hub-signature-256": createHmac("sha256", GH_SECRET).update(raw).digest("hex"),
      },
      body: raw,
    });
    expect(response.status).toBe(401);
  });
});

describe("event and ref filtering", () => {
  test("answers a ping without deploying", async () => {
    const response = await post({ zen: "hello" }, { event: "ping" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ pong: true });
  });

  test("ignores non-push events", async () => {
    const response = await post({ action: "opened" }, { event: "pull_request" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
  });

  test("ignores a push to a feature branch", async () => {
    // The important one: a branch push must never redeploy production.
    const response = await post({ ref: "refs/heads/some-feature" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
  });

  test("ignores a tag push", async () => {
    const response = await post({ ref: "refs/tags/v1.0.0" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: true });
  });

  test("a push to main with no deploy script installed fails loudly", async () => {
    const response = await post({ ref: "refs/heads/main", after: "abc123" });
    expect(response.status).toBe(500);
  });
});

describe("malformed input", () => {
  test("rejects invalid JSON with 400", async () => {
    const response = await post("{not json");
    expect(response.status).toBe(400);
  });
});
