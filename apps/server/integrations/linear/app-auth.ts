import { createHash } from "node:crypto";
import { z } from "zod";
import type { LinearAppCredential, LinearCredential } from "../../../../lib/linear-auth.ts";

const TokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.literal("Bearer"),
  expires_in: z.number().int().positive(),
});
type Token = { authorization: string; expiresAt: number };

/** One grant per credential at a time, including concurrent 401 responses.
 * Keep tokens only in memory, renew before expiry, and never log grant bodies. */
export function createLinearAppAuth(request: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init), now = Date.now) {
  const tokens = new Map<string, Token>();
  const pending = new Map<string, Promise<Token>>();
  const keyFor = (credential: LinearAppCredential) => createHash("sha256")
    .update(JSON.stringify([credential.clientId, credential.clientSecret])).digest("hex");

  async function grant(credential: LinearAppCredential): Promise<Token> {
    const response = await request("https://api.linear.app/oauth/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "read,write", client_id: credential.clientId, client_secret: credential.clientSecret }),
    });
    if (!response.ok) throw new Error(`Linear app authentication failed (HTTP ${response.status})`);
    const parsed = TokenSchema.safeParse(await response.json());
    if (!parsed.success) throw new Error("Linear app returned an invalid token response");
    return { authorization: `Bearer ${parsed.data.access_token}`, expiresAt: now() + parsed.data.expires_in * 1000 };
  }

  return {
    async authorization(credential: LinearCredential): Promise<string> {
      if (typeof credential === "string") return credential;
      const key = keyFor(credential);
      const current = tokens.get(key);
      if (current && current.expiresAt > now() + 60_000) return current.authorization;
      let issuing = pending.get(key);
      if (!issuing) {
        issuing = grant(credential).then((token) => { tokens.set(key, token); return token; }).finally(() => { pending.delete(key); });
        pending.set(key, issuing);
      }
      return (await issuing).authorization;
    },
    reject(credential: LinearCredential, authorization: string) {
      if (typeof credential === "string") return;
      const key = keyFor(credential);
      // A late 401 must not invalidate a newer token from another request.
      if (tokens.get(key)?.authorization === authorization) tokens.delete(key);
    },
  };
}

export const linearAppAuth = createLinearAppAuth();
