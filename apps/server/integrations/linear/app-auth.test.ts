import { afterEach, expect, test } from "bun:test";
import { createLinearAppAuth } from "./app-auth.ts";
import { linearGraphql } from "./client.ts";
import { LinearCredentialSchema } from "../../../../lib/linear-auth.ts";

const credential = { type: "app" as const, clientId: "app", clientSecret: "private-secret" };
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test("app grants are shared, renewed before expiry, and isolated by credentials", async () => {
  let now = 0;
  let grants = 0;
  const auth = createLinearAppAuth(async (url, init) => {
    expect(url).toBe("https://api.linear.app/oauth/token");
    expect(init.redirect).toBe("error");
    const params = init.body as URLSearchParams;
    expect(params.get("grant_type")).toBe("client_credentials");
    expect(params.get("scope")).toBe("read,write");
    return Response.json({ access_token: `token-${++grants}`, token_type: "Bearer", expires_in: 3600 });
  }, () => now);
  expect(await auth.authorization("personal-key")).toBe("personal-key");
  expect(grants).toBe(0);
  expect(await Promise.all([auth.authorization(credential), auth.authorization({ ...credential })])).toEqual(["Bearer token-1", "Bearer token-1"]);
  expect(grants).toBe(1);
  now = 3541_000;
  expect(await auth.authorization(credential)).toBe("Bearer token-2");
  auth.reject(credential, "Bearer token-1");
  expect(await auth.authorization(credential)).toBe("Bearer token-2");
  expect(await auth.authorization({ ...credential, clientSecret: "rotated" })).toBe("Bearer token-3");
  auth.reject(credential, "Bearer token-2");
  expect(await auth.authorization(credential)).toBe("Bearer token-4");
});

test("failed or malformed grants are not cached and do not expose response bodies", async () => {
  let attempt = 0;
  const auth = createLinearAppAuth(async () => {
    attempt++;
    if (attempt === 1) return new Response("private-secret", { status: 400 });
    if (attempt === 2) return Response.json({ access_token: "bad-token", token_type: "Bearer", expires_in: -1 });
    return Response.json({ access_token: "valid", token_type: "Bearer", expires_in: 3600 });
  });
  await expect(auth.authorization(credential)).rejects.toThrow("Linear app authentication failed (HTTP 400)");
  await expect(auth.authorization(credential)).rejects.toThrow("invalid token response");
  expect(await auth.authorization(credential)).toBe("Bearer valid");
  expect(LinearCredentialSchema.safeParse({ ...credential, clientSecret: "" }).success).toBe(false);
  expect(LinearCredentialSchema.safeParse({ ...credential, accessToken: "must-not-persist" }).success).toBe(false);
});

test("GraphQL renews once on 401, but never replays ambiguous mutations", async () => {
  let grants = 0;
  const authorizations: string[] = [];
  let status = 401;
  globalThis.fetch = (async (input: string, init: RequestInit) => {
    if (input.endsWith("/oauth/token")) return Response.json({ access_token: `live-${++grants}`, token_type: "Bearer", expires_in: 3600 });
    authorizations.push(new Headers(init.headers).get("authorization")!);
    const current = status;
    if (status === 401) status = 200;
    return current === 200 ? Response.json({ data: { ok: true } }) : new Response("failed", { status: current });
  }) as typeof fetch;
  const app = { ...credential, clientId: crypto.randomUUID() };
  expect(await linearGraphql<{ ok: boolean }>(app, "mutation { test } ")).toEqual({ ok: true });
  expect(authorizations).toEqual(["Bearer live-1", "Bearer live-2"]);
  expect(grants).toBe(2);
  status = 503;
  await expect(linearGraphql(app, "mutation { test } ")).rejects.toThrow("Linear HTTP 503");
  expect(authorizations).toHaveLength(3);
  globalThis.fetch = (async () => { throw new Error("lost response"); }) as unknown as typeof fetch;
  await expect(linearGraphql(app, "mutation { test } ")).rejects.toThrow("lost response");
});
