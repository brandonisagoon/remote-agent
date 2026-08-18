/*
  Warnings:

  - You are about to drop the column `tmuxPane` on the `AgentIssueRecord` table. All the data in the column will be lost.
  - You are about to drop the column `tmuxSession` on the `AgentIssueRecord` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "BbEventCursor" (
    "bbThreadId" TEXT NOT NULL PRIMARY KEY,
    "lastSeq" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentIssueRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "harnessSessionId" TEXT NOT NULL,
    "agentIssueId" TEXT NOT NULL,
    "agentIssueIdentifier" TEXT,
    "machine" TEXT,
    "bbThreadId" TEXT,
    "lastBbEventSeq" BIGINT,
    "lastEventId" TEXT,
    "lastGeneration" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AgentIssueRecord" ("agentIssueId", "agentIssueIdentifier", "createdAt", "harnessSessionId", "id", "lastEventId", "lastGeneration", "machine", "updatedAt") SELECT "agentIssueId", "agentIssueIdentifier", "createdAt", "harnessSessionId", "id", "lastEventId", "lastGeneration", "machine", "updatedAt" FROM "AgentIssueRecord";
DROP TABLE "AgentIssueRecord";
ALTER TABLE "new_AgentIssueRecord" RENAME TO "AgentIssueRecord";
CREATE UNIQUE INDEX "AgentIssueRecord_harnessSessionId_key" ON "AgentIssueRecord"("harnessSessionId");
CREATE UNIQUE INDEX "AgentIssueRecord_bbThreadId_key" ON "AgentIssueRecord"("bbThreadId");
CREATE INDEX "AgentIssueRecord_machine_idx" ON "AgentIssueRecord"("machine");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
