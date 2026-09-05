import { describe, expect, test } from "bun:test";

import type { PrismaClient } from "../../../../generated/prisma/client.ts";
import type { MessageDispatchResult } from "../../../../types/messages/index.ts";
import type { CommandClient } from "../../../../types/runtime/index.ts";
import {
  DispatchEventType,
  type DispatchEvent,
} from "../../../../types/dispatcher/index.ts";
import { testConfig } from "../../../../test-support/config.ts";
import { TrackerReaction } from "../../../integrations/tracker/index.ts";
import type { ForwardMessageOptions } from "../../../services/messages/index.ts";
import { createAgentMentionWorker } from "./worker.ts";

type MentionEvent = Extract<
  DispatchEvent,
  { type: typeof DispatchEventType.TrackerCommentMentioned }
>;

function event(
  parentId: string | null = "thread-root",
  routed: { routedSessionId?: string; threadRelationship?: "thread" | "question" } = {},
): MentionEvent {
  return {
    type: DispatchEventType.TrackerCommentMentioned,
    ...routed,
    webhook: {
      type: "Comment" as const,
      action: "create" as const,
      webhookTimestamp: Date.now(),
      data: {
        id: "source-comment",
        body: "@agent execute the combined plan",
        parentId,
        userId: "user-1",
        user: { id: "user-1", name: "Brandon" },
        issue: {
          id: "issue-1",
          identifier: "CUBE-2827",
          title: "Linear selection reply",
        },
      },
    },
  };
}

function context() {
  return {
    prisma: {} as PrismaClient,
    config: testConfig({ linearApiKey: "linear-key" }),
    commandClient: {} as CommandClient,
    runId: "run-1",
  };
}

function delivered(): MessageDispatchResult {
  return {
    status: "delivered",
    detail: "actions:reply,code_change reply_to:thread-root",
    targetAgentIssueIdentifier: "AGENT-9",
    decision: {
      targetAgentIssueIdentifier: "AGENT-9",
      reasonCode: "workflow_match",
      confidence: 0.95,
      expectedActions: ["reply", "code_change"],
      replyToCommentId: "thread-root",
    },
  };
}

describe("createAgentMentionWorker", () => {
  test("acknowledges receipt, forwards nested reply context, then reacts to the outcome", async () => {
    const reactions: string[] = [];
    const forwarded: ForwardMessageOptions[] = [];
    const worker = createAgentMentionWorker({
      fetchContext: async () => ({
        sourceIssueIdentifier: "CUBE-2827",
        quotedText: null,
        parentBody: "The combined plan is ready.",
        parentAuthor: "Agent",
      }),
      forward: async (options) => {
        forwarded.push(options);
        return delivered();
      },
      react: async (_key, _commentId, reaction) => {
        reactions.push(reaction);
        return true;
      },
    });

    const result = await worker.execute(event(), context());

    expect(result).toEqual({
      status: "delivered",
      detail: "actions:reply,code_change reply_to:thread-root",
      targetAgentIssueIdentifier: "AGENT-9",
    });
    expect(reactions).toEqual([
      TrackerReaction.Received,
      TrackerReaction.Delivered,
      TrackerReaction.Reply,
      TrackerReaction.CodeChange,
    ]);
    expect(forwarded[0]?.replyContext).toEqual({
      threadRootCommentId: "thread-root",
      targets: [
        {
          commentId: "source-comment",
          kind: "source",
          authorName: "Brandon",
          excerpt: "@agent execute the combined plan",
        },
        {
          commentId: "thread-root",
          kind: "thread_root",
          authorName: "Agent",
          excerpt: "The combined plan is ready.",
        },
      ],
    });
  });

  test("uses the source comment as the thread root for top-level mentions", async () => {
    let replyContext: unknown;
    const worker = createAgentMentionWorker({
      fetchContext: async () => ({
        sourceIssueIdentifier: "CUBE-2827",
        quotedText: null,
        parentBody: null,
        parentAuthor: null,
      }),
      forward: async (options) => {
        replyContext = options.replyContext;
        return delivered();
      },
      react: async () => true,
    });

    await worker.execute(event(null), context());

    expect(replyContext).toEqual({
      threadRootCommentId: "source-comment",
      targets: [
        {
          commentId: "source-comment",
          kind: "thread_root",
          authorName: "Brandon",
          excerpt: "@agent execute the combined plan",
        },
      ],
    });
  });

  test("warns and stops when the source issue cannot be resolved", async () => {
    const reactions: string[] = [];
    let forwarded = false;
    const unresolved = event();
    unresolved.webhook.data.issue = null;
    const worker = createAgentMentionWorker({
      fetchContext: async () => ({
        sourceIssueIdentifier: null,
        quotedText: null,
        parentBody: null,
        parentAuthor: null,
      }),
      forward: async () => {
        forwarded = true;
        return delivered();
      },
      react: async (_key, _commentId, reaction) => {
        reactions.push(reaction);
        return true;
      },
    });

    const result = await worker.execute(unresolved, context());

    expect(result).toEqual({
      status: "ignored",
      detail: "unresolved_source_issue",
      targetAgentIssueIdentifier: null,
    });
    expect(forwarded).toBeFalse();
    expect(reactions).toEqual([TrackerReaction.Received, TrackerReaction.Unrouted]);
  });

  test("warns after a no-candidate routing outcome", async () => {
    const reactions: string[] = [];
    const worker = createAgentMentionWorker({
      fetchContext: async () => ({
        sourceIssueIdentifier: "CUBE-2827",
        quotedText: null,
        parentBody: null,
        parentAuthor: null,
      }),
      forward: async () => ({
        status: "no_candidate",
        detail: "no eligible related Agents session",
        targetAgentIssueIdentifier: null,
        decision: null,
      }),
      react: async (_key, _commentId, reaction) => {
        reactions.push(reaction);
        return true;
      },
    });

    await worker.execute(event(), context());

    expect(reactions).toEqual([TrackerReaction.Received, TrackerReaction.Unrouted]);
  });

  test("marks a delivery failure after acknowledging receipt", async () => {
    const reactions: string[] = [];
    const worker = createAgentMentionWorker({
      fetchContext: async () => ({
        sourceIssueIdentifier: "CUBE-2827",
        quotedText: null,
        parentBody: null,
        parentAuthor: null,
      }),
      forward: async () => ({
        status: "failed",
        detail: "acpx rejected the exact registered thread",
        targetAgentIssueIdentifier: "AGENT-9",
        decision: null,
      }),
      react: async (_key, _commentId, reaction) => {
        reactions.push(reaction);
        return true;
      },
    });

    await worker.execute(event(), context());

    expect(reactions).toEqual([TrackerReaction.Received, TrackerReaction.Failed]);
  });

  test("registered threads route deterministically without the semantic router", async () => {
    const forwarded: ForwardMessageOptions[] = [];
    const worker = createAgentMentionWorker({
      fetchContext: async () => ({
        sourceIssueIdentifier: "CUBE-2827",
        quotedText: null,
        parentBody: "Should we ship?",
        parentAuthor: "Agent",
      }),
      forward: async (options) => {
        forwarded.push(options);
        return delivered();
      },
      react: async () => true,
    });

    await worker.execute(
      event("thread-root", { routedSessionId: "runtime-9" }),
      context(),
    );

    const selectSession = forwarded[0]?.selectSession;
    expect(selectSession).toBeDefined();
    const decision = await selectSession!(context().config, {
      sourceIssueIdentifier: "CUBE-2827",
      sourceIssue: null,
      comment: "ship it",
      workerContext: { key: "product.agent-mention", routingHint: "" },
      candidates: [
        {
          agentIssueId: "runtime-9",
          agentIssueIdentifier: "runtime-9",
          status: "Connected",
          assigneeId: null,
          labels: [],
          runtime: {
            harnessSessionId: "runtime-9",
            parentSessionId: null,
            worktreePath: "/wt",
            branchName: null,
            harness: "codex",
            machine: "macbook-air",
            role: "primary",
            lifecycle: null,
            sourceIssueIdentifier: "CUBE-2827",
            runtimeSessionId: "runtime-9",
          },
        },
      ],
    });
    expect(decision).toMatchObject({
      targetAgentIssueIdentifier: "runtime-9",
      reasonCode: "registered_thread",
      confidence: 1,
    });
  });

  test("question-thread replies are framed as answers", async () => {
    const forwarded: ForwardMessageOptions[] = [];
    const worker = createAgentMentionWorker({
      fetchContext: async () => ({
        sourceIssueIdentifier: "CUBE-2827",
        quotedText: null,
        parentBody: "Which approach?",
        parentAuthor: "Agent",
      }),
      forward: async (options) => {
        forwarded.push(options);
        return delivered();
      },
      react: async () => true,
    });

    await worker.execute(
      event("thread-root", {
        routedSessionId: "runtime-9",
        threadRelationship: "question",
      }),
      context(),
    );

    expect(forwarded[0]?.message).toStartWith(
      "This answers your earlier question in this thread.",
    );
  });
});