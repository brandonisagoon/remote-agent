/*
  Warnings:

  - You are about to drop the `SessionIssueMap` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "SessionIssueMap";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "SessionIssue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "harnessSessionId" TEXT NOT NULL,
    "linearIssueId" TEXT NOT NULL,
    "linearIssueIdentifier" TEXT,
    "machine" TEXT,
    "tmuxSession" TEXT,
    "tmuxPane" TEXT,
    "lastEventId" TEXT,
    "lastGeneration" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SessionIssue_harnessSessionId_key" ON "SessionIssue"("harnessSessionId");

-- CreateIndex
CREATE INDEX "SessionIssue_machine_tmuxPane_idx" ON "SessionIssue"("machine", "tmuxPane");
