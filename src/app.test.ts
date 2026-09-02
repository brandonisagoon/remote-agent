import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "./app.ts";
import type { ServerConfig } from "./lib/config.ts";
import type { PrismaClient } from "./generated/prisma/client.ts";
import { testConfig } from "./test-support/config.ts";
import { createFakeAgentRuntime } from "./test-support/agent-runtime.ts";
import { createTestDatabase, type TestDatabase } from "./test-support/db.ts";
import { verifyBearerToken } from "./lib/security.ts";
import { verifyTrackerWebhookSignature } from "./lib/integrations/tracker/index.ts";

const SECRET = "test-webhook-secret";
const API_KEY = "test-api-key";

const config: ServerConfig = testConfig({
  apiKey: API_KEY,
  webhookSecret: SECRET,
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

function app() {
  return createApp({ config, prisma, agentRuntime: createFakeAgentRuntime() });
}

function sign(body: string, secret = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

describe("health", () => {
  test("is public and reports ok", async () => {
    const response = await app().request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
  });

  test("is never cached", async () => {
    const response = await app().request("/health");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});

describe("unknown routes", () => {
  test("404 rather than falling through", async () => {
    const response = await app().request("/nope");
    expect(response.status).toBe(404);
  });
});

describe("/api authentication", () => {
  test("rejects a missing Authorization header", async () => {
    const response = await app().request("/api/launches", {
      method: "POST",
    });
    expect(response.status).toBe(401);
  });

  test("rejects a wrong bearer token", async () => {
    const response = await app().request("/api/session-events", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(response.status).toBe(401);
  });

  test("rejects a bare token without the Bearer scheme", async () => {
    const response = await app().request("/api/session-events", {
      method: "POST",
      headers: { authorization: API_KEY },
    });
    expect(response.status).toBe(401);
  });

  test("a correct token reaches validation", async () => {
    const response = await app().request("/api/launches", {
      method: "POST",
      headers: { authorization: `Bearer ${API_KEY}` },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "Invalid body" });
  });

  test("an unknown /api path is 404, not 401, once authenticated", async () => {
    const response = await app().request("/api/nope", {
      headers: { authorization: `Bearer ${API_KEY}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("verifyTrackerWebhookSignature", () => {
  const body = JSON.stringify({ type: "Comment", action: "create" });

  test("accepts a signature over the raw body", () => {
    expect(verifyTrackerWebhookSignature(body, sign(body), SECRET)).toBe(true);
  });

  test("rejects a signature made with a different secret", () => {
    expect(verifyTrackerWebhookSignature(body, sign(body, "other"), SECRET)).toBe(
      false,
    );
  });

  test("rejects when the body was altered after signing", () => {
    const signature = sign(body);
    expect(verifyTrackerWebhookSignature(`${body} `, signature, SECRET)).toBe(false);
  });

  test("rejects a missing signature", () => {
    expect(verifyTrackerWebhookSignature(body, null, SECRET)).toBe(false);
  });

  test("rejects malformed signatures without throwing", () => {
    for (const bad of ["", "abc", "z".repeat(64), `${sign(body)}00`]) {
      expect(verifyTrackerWebhookSignature(body, bad, SECRET)).toBe(false);
    }
  });
});

describe("verifyBearerToken", () => {
  test("accepts the expected token", () => {
    expect(verifyBearerToken(`Bearer ${API_KEY}`, API_KEY)).toBe(true);
  });

  test("rejects a token that only shares a prefix", () => {
    expect(verifyBearerToken(`Bearer ${API_KEY}extra`, API_KEY)).toBe(false);
  });

  test("rejects a null header", () => {
    expect(verifyBearerToken(null, API_KEY)).toBe(false);
  });
});
