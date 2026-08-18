import type { ServerConfig } from "../../config.ts";
import { signBbThreadLink } from "../../security.ts";

export function buildBbThreadOpenLink(
  config: Pick<ServerConfig, "apiKey" | "publicUrl">,
  threadId: string,
): string {
  const url = new URL(
    `/session-links/bb/${encodeURIComponent(threadId)}`,
    `${config.publicUrl.replace(/\/$/, "")}/`,
  );
  url.searchParams.set("signature", signBbThreadLink(threadId, config.apiKey));
  return url.toString();
}
