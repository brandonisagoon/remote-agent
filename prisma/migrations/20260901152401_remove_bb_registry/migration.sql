/*
  Warnings:

  - You are about to drop the `BbEventCursor` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `bbThreadId` on the `AgentIssueRecord` table. All the data in the column will be lost.
  - You are about to drop the column `lastBbEventSeq` on the `AgentIssueRecord` table. All the data in the column will be lost.
  - You are about to drop the column `lastErrorAt` on the `AgentIssueRecord` table. All the data in the column will be lost.
  - You are about to drop the column `lastErrorCommentId` on the `AgentIssueRecord` table. All the data in the column will be lost.
  - You are about to drop the column `lastErrorEventId` on the `AgentIssueRecord` table. All the data in the column will be lost.
  - You are about to drop the column `lastErrorTurnId` on the `AgentIssueRecord` table. All the data in the column will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "BbEventCursor";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_AgentIssueRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "harnessSessionId" TEXT NOT NULL,
    "agentIssueId" TEXT NOT NULL,
    "agentIssueIdentifier" TEXT,
    "machine" TEXT,
    "lastEventId" TEXT,
    "lastGeneration" BIGINT,
    "sessionRootCommentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_AgentIssueRecord" ("agentIssueId", "agentIssueIdentifier", "createdAt", "harnessSessionId", "id", "lastEventId", "lastGeneration", "machine", "sessionRootCommentId", "updatedAt") SELECT "agentIssueId", "agentIssueIdentifier", "createdAt", "harnessSessionId", "id", "lastEventId", "lastGeneration", "machine", "sessionRootCommentId", "updatedAt" FROM "AgentIssueRecord";
DROP TABLE "AgentIssueRecord";
ALTER TABLE "new_AgentIssueRecord" RENAME TO "AgentIssueRecord";
CREATE UNIQUE INDEX "AgentIssueRecord_harnessSessionId_key" ON "AgentIssueRecord"("harnessSessionId");
CREATE INDEX "AgentIssueRecord_machine_idx" ON "AgentIssueRecord"("machine");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
