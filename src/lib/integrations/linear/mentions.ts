/**
 * Does this comment address our agent?
 *
 * Verified against a real Linear webhook (CUBE-2600, 2026-07-27). Linear sends
 * the mention as a **plain `@handle` string** in `data.body`:
 *
 *     "body": "@agent this is a test"
 *
 * No markdown link, no profile URL, and — importantly — **the mentioned user's
 * UUID does not appear in the body at all**. The comment payload carries only
 * the author's id in `data.userId`; the mentioned user surfaces separately, as
 * an addition to the issue's `subscriberIds` on a following `Issue` event.
 *
 * So the handle match is what actually does the work here. The UUID branch is
 * kept as a cheap fallback in case Linear ever emits a richer encoding (or an
 * agent-session event does), but it has never been observed to fire.
 *
 * The consequence worth knowing: matching is purely textual, so any comment
 * containing the literal "@agent" qualifies — including one merely talking
 * about the agent. That is the intended trade. A false positive costs a stray
 * prompt in a session you own; a false negative silently drops the comment you
 * were waiting on.
 */

export interface MentionMatchOptions {
  agentUserId: string;
  agentHandle: string | null;
}

/** Escape a value for safe interpolation into a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function mentionsAgent(
  body: string,
  { agentUserId, agentHandle }: MentionMatchOptions,
): boolean {
  if (!body) return false;

  // Form 1: the user's UUID appears in the body at all — covers Linear's
  // profile-link mention markup, e.g. @[Name](https://linear.app/../profiles/<id>)
  // as well as any raw-id encoding.
  if (agentUserId && body.includes(agentUserId)) return true;

  // Form 2: a plain @handle. Bounded on the left so "email@handle" doesn't
  // match, and on the right so "@handlebars" doesn't either.
  if (agentHandle) {
    const handle = escapeRegExp(agentHandle);
    const plain = new RegExp(`(^|[^\\w@])@${handle}\\b`, "i");
    if (plain.test(body)) return true;
  }

  return false;
}
