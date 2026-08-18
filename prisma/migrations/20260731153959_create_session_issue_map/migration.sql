-- CreateTable
CREATE TABLE "SessionIssueMap" (
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
CREATE UNIQUE INDEX "SessionIssueMap_harnessSessionId_key" ON "SessionIssueMap"("harnessSessionId");

-- CreateIndex
CREATE INDEX "SessionIssueMap_machine_tmuxPane_idx" ON "SessionIssueMap"("machine", "tmuxPane");
