import type { MessageContext } from "../../../../types/messages/index.ts";

export function excerpt(text: string, limit = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

export function buildAgentMentionMessage(
  cubeIssueIdentifier: string,
  authorName: string | null,
  body: string,
  context: MessageContext = {},
): string {
  const who = authorName ? ` — ${authorName}` : "";
  const parts = [`[Linear ${cubeIssueIdentifier}${who}]`];
  if (context.quotedText) {
    parts.push(`(on: "${excerpt(context.quotedText)}")`);
  } else if (context.parentBody) {
    const from = context.parentAuthor
      ? `${context.parentAuthor}: `
      : "";
    parts.push(
      `(replying to ${from}"${excerpt(context.parentBody)}")`,
    );
  }
  parts.push(body);
  return parts.join(" ");
}

/**
 * Reflection behavior lives in the skill. The service only requests that the
 * selected live session invoke it; Linear itself retains the resulting thread.
 */
