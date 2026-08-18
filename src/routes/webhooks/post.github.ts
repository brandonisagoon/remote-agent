import { Hono } from "hono";

import { MAX_REQUEST_BYTES } from "../../lib/config.ts";
import { verifyGithubSignature } from "../../lib/security.ts";
import {
  DeployScriptMissingError,
  triggerDeploy,
} from "../../lib/services/deploy/index.ts";
import type { AppEnv } from "../../middleware/context.ts";

const route = new Hono<AppEnv>();

route.post("/", async (c) => {
    const config = c.get("config");

    const declaredLength = Number(c.req.header("content-length") ?? "0");
    if (declaredLength > MAX_REQUEST_BYTES) {
      return c.json({ error: "Payload Too Large" }, 413);
    }

    // Raw body again — GitHub signs the exact bytes.
    const rawBody = await c.req.text();
    if (Buffer.byteLength(rawBody) > MAX_REQUEST_BYTES) {
      return c.json({ error: "Payload Too Large" }, 413);
    }

    if (
      !verifyGithubSignature(
        rawBody,
        c.req.header("x-hub-signature-256") ?? null,
        config.githubWebhookSecret,
      )
    ) {
      return c.json({ error: "Invalid signature" }, 401);
    }

    const event = c.req.header("x-github-event");
    if (event === "ping") {
      return c.json({ accepted: true, pong: true }, 200);
    }
    if (event !== "push") {
      return c.json({ accepted: true, ignored: true, reason: `event ${event}` }, 200);
    }

    let payload: { ref?: string; after?: string };
    try {
      payload = JSON.parse(rawBody) as typeof payload;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }

    // Only the deploy branch. Feature-branch pushes must not redeploy.
    const expectedRef = `refs/heads/${config.deployBranch}`;
    if (payload.ref !== expectedRef) {
      return c.json({ accepted: true, ignored: true, reason: `ref ${payload.ref}` }, 200);
    }

    try {
      triggerDeploy(config, {
        ref: payload.ref,
        commit: payload.after,
      });
    } catch (error) {
      if (error instanceof DeployScriptMissingError) {
        console.error(error.message);
        return c.json({ error: "Deploy script not installed" }, 500);
      }
      throw error;
    }

    return c.json({ accepted: true, deploying: true, commit: payload.after }, 202);
});

export default route;
