import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { testConfig } from "../../../../../test-support/config.ts";
import { createTestDatabase } from "../../../../../test-support/db.ts";
import { composeForPrompt } from "../../../../../lib/skills/compose.ts";
import { findThreadSession } from "../../../services/sessions/threads.ts";
import {
  buildWorktreeLinkComment,
  postWorktreeLinkComment,
  WORKTREE_LINK_SEARCH_TEXT,
} from "./comment.ts";

const originalConsoleError = console.error;

afterEach(() => {
  console.error = originalConsoleError;
});

describe("orchestration worktree link comment", () => {
  test("DRA-61 replays the original DRA-21 link as navigation without assigning the coordinating chat or changing product files", async () => {
    // Incident identities are inert fixture values, never filesystem targets or
    // live provider handles. No actual DRA-21 worktree or chat is opened.
    const incident = {
      issueId: "c9cc74d8-17c2-4345-afcd-8808da891784", taskId: "cmvqypneq00x83cxcbvek3wzf",
      primaryId: "cmvqyps7y00x93cxc71oym4fr", acpxSessionId: "01a17e6a-dc29-7421-9bbe-9ffd374d4563",
      coordinatorChatId: "01a17e6b-3c7e-7f03-9b20-9f8563395504",
      worktree: "/Users/brandon/Desktop/.worktrees/drafted/drafted-dra-21-keep-the-latest-chat-message-visible-when-a-tool-opens-above",
      toolingRevision: "f49372ee771e92decc86ebb8fd2e9437e178fac4",
    };
    const repositoryRoot = path.resolve(import.meta.dir, "../../../../..");
    const agents = await readFile(path.join(repositoryRoot, "AGENTS.md"), "utf8");
    const claude = await readFile(path.join(repositoryRoot, "CLAUDE.md"), "utf8");
    const ownershipPolicy = (text: string) => text.match(/- A product worktree\/editor link[\s\S]*?(?=\n\n)/)?.[0];
    expect(ownershipPolicy(agents)).toBeDefined();
    expect(ownershipPolicy(agents)).toBe(ownershipPolicy(claude));
    expect(ownershipPolicy(agents)).toContain("navigation and evidence, not delegation");
    expect(ownershipPolicy(agents)).toContain("do not edit the linked product worktree or start another writer without an");
    expect(ownershipPolicy(agents)).toContain("explicit assignment");
    expect(ownershipPolicy(agents)).toContain("Attribute results to the actual task, session and host");

    const fixture = await mkdtemp(path.join(tmpdir(), "dra61-navigation-replay-"));
    const db = await createTestDatabase();
    try {
      const product = path.join(fixture, "greenfield-product"), coordinator = path.join(fixture, "remote-agent-coordinator");
      await mkdir(product); await mkdir(coordinator);
      await writeFile(path.join(coordinator, "AGENTS.md"), agents);
      for (const name of ["chat-layout.tsx", "chat-messages.tsx", "chat-composer.tsx", "chat-tool.tsx", "chat-scroll.ts"]) {
        await writeFile(path.join(product, name), `// Historical/user changes in ${name}; retain exactly.\n`);
      }
      const snapshot = async () => Promise.all((await readdir(product)).sort().map(async (name) => [name, await readFile(path.join(product, name), "utf8")]));
      const before = await snapshot();
      const config = testConfig();
      await db.prisma.runtimeSession.create({ data: { id: incident.primaryId, scopeKey: "original-dra21", agentCommand: "codex", role: "primary", status: "idle", cwd: incident.worktree, repositoryId: config.activeRepositoryId, machineId: "macbook-air", acpxRecordId: incident.primaryId, acpxSessionId: incident.acpxSessionId } });
      const task = await db.prisma.remoteTask.create({ data: { id: incident.taskId, requestKey: "DRA-21", issueIdentifier: "DRA-21", connectionId: config.activeConnectionId, repositoryId: config.activeRepositoryId, machineId: "macbook-air", branchName: "codex/dra21", worktreePath: incident.worktree, toolingRoot: "/fixture/pinned-tooling", toolingRevision: incident.toolingRevision, primarySessionId: incident.primaryId } });
      let body = "";
      expect(await postWorktreeLinkComment({ config, prisma: db.prisma, issueId: incident.issueId, worktreePath: task.worktreePath!, runtimeSessionId: task.primarySessionId! }, {
        hasCommentContaining: async () => false,
        createComment: async (_key, issueId, text) => { expect(issueId).toBe(incident.issueId); body = text; return "fixture-dra21-navigation-comment"; },
      })).toBe("posted");
      expect(body).toContain(incident.worktree);
      expect(body).toContain(`Remote Agent session \`${incident.primaryId}\``);
      expect(body).toContain("does not assign implementation to another chat");
      expect(body).toContain("Send corrections to its owning primary instead of starting another writer");
      expect(body).not.toContain(incident.coordinatorChatId);
      const composed = await composeForPrompt(product, `Status request only for task ${task.id}.\n${body}`, "codex", "agent-skills", coordinator);
      expect(composed).toContain(ownershipPolicy(agents)!);
      expect(composed).toContain(`Status request only for task ${incident.taskId}`);
      expect(await snapshot()).toEqual(before);
      expect((await findThreadSession(db.prisma, { provider: "linear", connectionId: config.activeConnectionId, threadRootCommentId: "fixture-dra21-navigation-comment" }))?.runtimeSessionId).toBe(incident.primaryId);
      expect(await db.prisma.remoteTask.findUniqueOrThrow({ where: { id: task.id } })).toEqual(task);
      expect(await db.prisma.runtimeSession.count()).toBe(1);
      expect(await db.prisma.runtimeInstruction.count()).toBe(0);
    } finally { await db.cleanup(); await rm(fixture, { recursive: true, force: true }); }
  });

  test("builds an SSH worktree link with the runtime session", () => {
    const body = buildWorktreeLinkComment({
      editors: [{ name: "Zed", scheme: "zed", connection: "ssh", remoteHost: "test-remote" }],
      worktreePath: "/srv/worktrees/foo-cube-2829",
      runtimeSessionId: "runtime_2829",
    });
    expect(body).toContain(
      "[Open Worktree in Zed](zed://ssh/test-remote/srv/worktrees/foo-cube-2829)",
    );
    expect(body).toContain("Remote Agent session `runtime_2829`");
    expect(body).toContain("does not assign implementation to another chat");
    expect(body).toContain("Send corrections to its owning primary");
    expect(body).not.toContain("<!--");
  });

  test("builds the exact local-machine comment body", () => {
    expect(
      buildWorktreeLinkComment({
        editors: [{ name: "Zed", scheme: "zed", connection: "local", remoteHost: null }],
        worktreePath: "/srv/worktrees/foo cube",
        runtimeSessionId: "runtime_local",
      }),
    ).toContain(
      "[Open Worktree in Zed](zed://file/srv/worktrees/foo%20cube)",
    );
  });

  test("skips a duplicate visible link without creating a comment", async () => {
    const created: string[] = [];
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        worktreePath: "/workspace/.worktrees/feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        hasCommentContaining: async () => true,
        createComment: async (_key, _issueId, body) => {
          created.push(body);
          return "comment-1";
        },
      },
    );

    expect(outcome).toBe("skipped");
    expect(created).toHaveLength(0);
  });

  test("posts a comment linking the provisioned worktree path", async () => {
    const created: Array<{ issueId: string; body: string }> = [];
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        worktreePath: "/workspace/.worktrees/cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        hasCommentContaining: async () => false,
        createComment: async (_key, issueId, body) => {
          created.push({ issueId, body });
          return "comment-1";
        },
      },
    );

    expect(outcome).toBe("posted");
    expect(created).toHaveLength(1);
    expect(created[0]?.issueId).toBe("issue-id");
    expect(created[0]?.body).toContain(WORKTREE_LINK_SEARCH_TEXT);
    expect(created[0]?.body).toContain("/workspace/.worktrees/cube-2829");
    expect(created[0]?.body).toContain("Remote Agent session `runtime_2829`");
    expect(created[0]?.body).not.toContain("<!--");
  });

  test("reports comment creation failure without throwing", async () => {
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        worktreePath: "/workspace/.worktrees/feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        hasCommentContaining: async () => false,
        createComment: async () => null,
      },
    );

    expect(outcome).toBe("failed");
  });

  test("converts an unexpected dependency error into failure", async () => {
    console.error = () => {};
    const outcome = await postWorktreeLinkComment(
      {
        config: testConfig(),
        issueId: "issue-id",
        worktreePath: "/workspace/.worktrees/feature-cube-2829",
        runtimeSessionId: "runtime_2829",
      },
      {
        hasCommentContaining: async () => {
          throw new Error("boom");
        },
        createComment: async () => "comment-1",
      },
    );

    expect(outcome).toBe("failed");
  });
});
