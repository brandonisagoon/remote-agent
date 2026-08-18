import { Hono, type Context } from "hono";

import type { AppEnv } from "../../middleware/context.ts";
import { verifyBbThreadLink } from "../../lib/security.ts";

const route = new Hono<AppEnv>();

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function page(input: {
  heading: string;
  detail: string;
  action?: string;
}): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${input.heading}</title>
    <style>
      :root { color-scheme: light dark; font: 16px system-ui, sans-serif; }
      body { display: grid; min-height: 100vh; margin: 0; place-items: center; }
      main { max-width: 32rem; padding: 2rem; text-align: center; }
      button { font: inherit; padding: .65rem 1rem; cursor: pointer; }
    </style>
  </head>
  <body><main><h1>${input.heading}</h1><p>${input.detail}</p>${
    input.action
      ? `<form method="post" action="${escapeHtml(input.action)}"><button type="submit">Open in bb</button></form>`
      : ""
  }</main></body>
</html>`;
}

async function openThread(c: Context<AppEnv, "/:threadId">) {
  const config = c.get("config");
  const threadId = c.req.param("threadId");
  const signature = c.req.query("signature") ?? null;
  if (!verifyBbThreadLink(threadId, signature, config.apiKey)) {
    return c.html(
      page({
        heading: "Link unavailable",
        detail: "This bb thread link is invalid.",
      }),
      404,
    );
  }

  const thread = await c.get("bbClient").getThread(threadId);
  if (!thread || thread.projectId !== config.bbProjectId) {
    return c.html(
      page({
        heading: "Thread unavailable",
        detail: "This bb thread no longer exists.",
      }),
      404,
    );
  }

  const delivered = await c.get("bbClient").openThread(threadId);
  return c.html(
    page(
      delivered > 0
        ? { heading: "Opened in bb", detail: "You can close this tab." }
        : {
            heading: "bb is not connected",
            detail:
              "Open the bb desktop app on your MacBook Pro, then try the link again.",
          },
    ),
    delivered > 0 ? 200 : 503,
  );
}

route.get("/:threadId", async (c) => {
  const isUserNavigation =
    c.req.header("sec-fetch-mode") === "navigate" &&
    c.req.header("sec-fetch-user") === "?1";
  if (isUserNavigation) return openThread(c);

  return c.html(
    page({
      heading: "Open bb thread",
      detail: "Open this server-owned session in a connected bb desktop app.",
      action: c.req.url,
    }),
  );
});

route.post("/:threadId", openThread);

export default route;
