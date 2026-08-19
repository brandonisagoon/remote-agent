import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApp } from "./app.ts";
import type { ServerConfig } from "./lib/config.ts";
import type { PrismaClient } from "./generated/prisma/client.ts";
import { testConfig } from "./test-support/config.ts";
import { createFakeBbClient } from "./test-support/bb.ts";
import { createTestDatabase, type TestDatabase } from "./test-support/db.ts";
import { buildBbThreadOpenLink } from "./lib/transports/bb/thread-link.ts";
import {
  verifyBearerToken,
  verifyGithubSignature,
} from "./lib/security.ts";
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

function app(bbClient?: ReturnType<typeof createFakeBbClient>) {
  return createApp({ config, prisma, bbClient });
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

describe("bb session links", () => {
  const thread = {
    id: "thr_open_me",
    projectId: config.bbProjectId,
    environmentId: "env_test",
    hostId: "host_air",
    providerId: "codex",
    title: "Test thread",
    status: "idle" as const,
    parentThreadId: null,
    archivedAt: null,
  };

  test("opens a signed project thread on explicit browser navigation", async () => {
    const bbClient = createFakeBbClient([thread]);
    const link = buildBbThreadOpenLink(config, thread.id);
    const response = await app(bbClient).request(link, {
      headers: { "sec-fetch-mode": "navigate", "sec-fetch-user": "?1" },
    });

    expect(response.status).toBe(200);
    expect(bbClient.openedThreadIds).toEqual([thread.id]);
  });

  test("does not let a link preview open the desktop app", async () => {
    const bbClient = createFakeBbClient([thread]);
    const response = await app(bbClient).request(
      buildBbThreadOpenLink(config, thread.id),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Open in bb");
    expect(bbClient.openedThreadIds).toHaveLength(0);
  });

  test("rejects invalid signatures and threads from other projects", async () => {
    const bbClient = createFakeBbClient([
      { ...thread, id: "thr_other", projectId: "proj_other" },
    ]);
    const invalid = await app(bbClient).request(
      `/session-links/bb/${thread.id}?signature=${"0".repeat(64)}`,
      { headers: { "sec-fetch-mode": "navigate", "sec-fetch-user": "?1" } },
    );
    const other = await app(bbClient).request(
      buildBbThreadOpenLink(config, "thr_other"),
      { headers: { "sec-fetch-mode": "navigate", "sec-fetch-user": "?1" } },
    );

    expect(invalid.status).toBe(404);
    expect(other.status).toBe(404);
    expect(bbClient.openedThreadIds).toHaveLength(0);
  });
});

describe("/api authentication", () => {
  test("rejects a missing Authorization header", async () => {
    const response = await app().request("/api/session-events", {
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
    const response = await app().request("/api/session-events", {
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

describe("verifyGithubSignature", () => {
  const body = JSON.stringify({ ref: "refs/heads/main" });
  const secret = "test-github-secret";

  test("accepts a correctly prefixed signature", () => {
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(verifyGithubSignature(body, signature, secret)).toBe(true);
  });

  test("rejects a signature missing the sha256= prefix", () => {
    const bare = createHmac("sha256", secret).update(body).digest("hex");
    expect(verifyGithubSignature(body, bare, secret)).toBe(false);
  });

  test("rejects a malformed signature", () => {
    expect(verifyGithubSignature(body, "sha256=nope", secret)).toBe(false);
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
