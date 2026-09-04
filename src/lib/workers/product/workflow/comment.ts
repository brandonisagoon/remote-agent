import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ServerConfig } from "../../../config.ts";
import {
  createIssueComment,
  issueHasCommentContaining,
} from "../../../integrations/linear/comments.ts";
import {
  buildEditorDeepLink,
  getMachine,
  type MachineRecord,
} from "../../../machines/index.ts";
import { worktreePathForBranch } from "../../../services/launches/index.ts";

export const WORKTREE_LINK_SEARCH_TEXT = "Open Worktree in ";
export const WORKTREE_READY_TIMEOUT_MS = 15 * 60_000;

const WORKTREE_BRANCH_STAMP = path.join(".workspace-stamps", "branch");
const WORKTREE_SESSION_STAMP = path.join(
  ".workspace-stamps",
  "session-generation",
);
export type WorktreeLinkCommentOutcome = "posted" | "skipped" | "failed";

interface WorktreeLinkCommentDependencies {
  createComment: typeof createIssueComment;
  hasCommentContaining: typeof issueHasCommentContaining;
  waitForReady: typeof waitForWorktreeReady;
}

const defaultDependencies: WorktreeLinkCommentDependencies = {
  createComment: createIssueComment,
  hasCommentContaining: issueHasCommentContaining,
  waitForReady: waitForWorktreeReady,
};

interface WorktreeReadyDependencies {
  exists: (file: string) => boolean;
  now: () => number;
  read: (file: string) => string;
  sleep: (milliseconds: number) => Promise<void>;
}

const defaultReadyDependencies: WorktreeReadyDependencies = {
  exists: existsSync,
  now: Date.now,
  read: (file) => readFileSync(file, "utf8"),
  sleep: Bun.sleep,
};

export function predictWorktreePath(
  worktreeRoot: string,
  branchName: string,
): string {
  return worktreePathForBranch(worktreeRoot, branchName);
}

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

export async function waitForWorktreeReady(
  input: {
    worktreePath: string;
    branchName: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  },
  dependencies: WorktreeReadyDependencies = defaultReadyDependencies,
): Promise<boolean> {
  const deadline =
    dependencies.now() + (input.timeoutMs ?? WORKTREE_READY_TIMEOUT_MS);
  const branchStamp = path.join(input.worktreePath, WORKTREE_BRANCH_STAMP);
  const sessionStamp = path.join(input.worktreePath, WORKTREE_SESSION_STAMP);
  while (dependencies.now() <= deadline) {
    try {
      if (
        dependencies.exists(sessionStamp) &&
        dependencies.exists(branchStamp)
      ) {
        const sessionGeneration = dependencies.read(sessionStamp).trim();
        if (
          sessionGeneration &&
          dependencies.read(branchStamp).trim() === input.branchName
        ) {
          return true;
        }
      }
    } catch {
      // Worktree creation writes these files concurrently; retry partial reads.
    }
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) return false;
    await dependencies.sleep(
      Math.min(input.pollIntervalMs ?? 1_000, remainingMs),
    );
  }
  return false;
}

export async function postWorktreeLinkComment(
  input: {
    config: ServerConfig;
    issueId: string;
    branchName: string;
    runtimeSessionId: string;
    timeoutMs?: number;
    pollIntervalMs?: number;
  },
  dependencies: WorktreeLinkCommentDependencies = defaultDependencies,
): Promise<WorktreeLinkCommentOutcome> {
  try {
    const machine = getMachine({ id: input.config.machine });
    const worktreePath = predictWorktreePath(
      input.config.repository.worktreeRoot,
      input.branchName,
    );
    const ready = await dependencies.waitForReady({
      worktreePath,
      branchName: input.branchName,
      timeoutMs: input.timeoutMs,
      pollIntervalMs: input.pollIntervalMs,
    });
    if (!ready) {
      console.error(
        `Worktree did not finish bootstrapping before the comment timeout: ${worktreePath}`,
      );
      return "failed";
    }

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
      worktreePath,
      runtimeSessionId: input.runtimeSessionId,
    });
    return (await dependencies.createComment(
      input.config.linearApiKey,
      input.issueId,
      body,
    ))
      ? "posted"
      : "failed";
  } catch (error) {
    console.error(
      `Failed to post worktree link comment on issue ${input.issueId}:`,
      error,
    );
    return "failed";
  }
}
