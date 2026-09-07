import type { PrismaClient } from "../../../../../generated/prisma/client.ts";
import type { ServerConfig } from "../../../../../lib/config.ts";
import { registerThread } from "../../../services/sessions/threads.ts";
import {
  createIssueComment,
  issueHasCommentContaining,
} from "../../../integrations/linear/comments.ts";
import { buildEditorDeepLink } from "../../../../../lib/machines/index.ts";

export const WORKTREE_LINK_SEARCH_TEXT = "Open Worktree in ";

export type WorktreeLinkCommentOutcome = "posted" | "skipped" | "failed";

interface WorktreeLinkCommentDependencies {
  createComment: typeof createIssueComment;
  hasCommentContaining: typeof issueHasCommentContaining;
}

const defaultDependencies: WorktreeLinkCommentDependencies = {
  createComment: createIssueComment,
  hasCommentContaining: issueHasCommentContaining,
};

export function buildWorktreeLinkComment(input: {
  editors: ReadonlyArray<{ name: string; scheme: string; connection: "local" | "ssh"; remoteHost: string | null }>;
  worktreePath: string;
  runtimeSessionId: string;
}): string {
  const links = input.editors.map((editor) => {
    const link = buildEditorDeepLink(
      editor.connection,
      editor.scheme,
      editor.remoteHost,
      input.worktreePath,
    );
    return `[Open Worktree in ${editor.name}](${link})`;
  });
  return [...links, `Remote Agent session \`${input.runtimeSessionId}\``].join(" · ");
}

/** Posts the editor deep links once the worktree exists. The caller passes
    the provisioned path — bootstrap has already been awaited to a successful
    exit by then, which IS the readiness signal. */
export async function postWorktreeLinkComment(
  input: {
    config: ServerConfig;
    issueId: string;
    worktreePath: string;
    runtimeSessionId: string;
    prisma?: PrismaClient;
  },
  dependencies: WorktreeLinkCommentDependencies = defaultDependencies,
): Promise<WorktreeLinkCommentOutcome> {
  try {
    if (
      await dependencies.hasCommentContaining(
        input.config.linearApiKey,
        input.issueId,
        WORKTREE_LINK_SEARCH_TEXT,
      )
    ) {
      return "skipped";
    }

    const body = buildWorktreeLinkComment({
      editors: input.config.editors,
      worktreePath: input.worktreePath,
      runtimeSessionId: input.runtimeSessionId,
    });
    const commentId = await dependencies.createComment(
      input.config.linearApiKey,
      input.issueId,
      body,
    );
    if (commentId && input.prisma) {
      // The session owns its worktree-link thread from birth.
      await registerThread(input.prisma, {
        provider: "linear",
        connectionId: input.config.activeConnectionId,
        threadRootCommentId: commentId,
        runtimeSessionId: input.runtimeSessionId,
        relationship: "thread",
      }).catch(() => undefined);
    }
    return commentId ? "posted" : "failed";
  } catch (error) {
    console.error(
      `Failed to post worktree link comment on issue ${input.issueId}:`,
      error,
    );
    return "failed";
  }
}
