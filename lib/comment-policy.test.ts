import { expect, test } from "bun:test";
import { RepoConfigSchema } from "./config.ts";
import { matchWorkflows } from "../apps/server/workflows/match.ts";
import { testConfig } from "../test-support/config.ts";
import { reactionEmojiTokens, matchesReactionEmoji } from "../apps/server/integrations/linear/webhooks/reaction/emoji.ts";

test("unconfigured repositories do not acquire comment controls or reaction vocabulary", () => {
  const parsed = RepoConfigSchema.parse({});
  expect(parsed.workflows).toEqual({}); expect(parsed.conversationReactions).toBeUndefined();
});

test("ordinary input and explicit steering reuse the configured event/delivery contract without a skill", () => {
  const parsed = RepoConfigSchema.parse({ workflows: {
    comments: { on: "comment.created", deliver: "queue-session" },
    steer: { on: "comment.reaction", when: [{ "reaction.emoji": ["🧭"] }], deliver: "steer-session" },
  }, conversationReactions: { queued: "⏳", processing: "👀", replied: "💬" } });
  expect(parsed.workflows.comments!.skill).toEqual({ skillset: "", flags: [] });
  const config = testConfig();
  Object.assign(config.repository.workflows, { steer: { ...parsed.workflows.steer, id: "steer", connectionId: null } });
  for (const raw of ["🧭", "compass", ":compass:"]) expect(matchWorkflows({ config, on: "comment.reaction", fields: { "reaction.emoji": reactionEmojiTokens(raw) } }).map((workflow) => workflow.id)).toEqual(["steer"]);
  expect(matchesReactionEmoji("eyes", "👀")).toBe(true);
  expect(matchesReactionEmoji("👀", "eyes")).toBe(true);
});

test.each([
  { on: "comment.reaction", deliver: "steer-session" },
  { on: "comment.created", deliver: "start-session", skill: { skillset: "implement" } },
  { on: "comment.created", deliver: "queue-session", skill: { skillset: "implement" } },
  { on: "comment.created", deliver: "queue-session", skill: { skillset: "", flags: ["ignored-policy"] } },
  { on: "issue.reaction", deliver: "steer-session", skill: { skillset: "implement" } },
  { on: "issue.reaction", deliver: "start-session" },
])("invalid or unbounded conversation policy is rejected: %j", (workflow) => {
  expect(RepoConfigSchema.safeParse({ workflows: { invalid: workflow } }).success).toBe(false);
});
