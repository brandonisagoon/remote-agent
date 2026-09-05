-- CreateTable
CREATE TABLE "RuntimeSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeKey" TEXT NOT NULL,
    "acpxRecordId" TEXT,
    "acpxSessionId" TEXT,
    "agentSessionId" TEXT,
    "agentCommand" TEXT NOT NULL,
    "cwd" TEXT NOT NULL,
    "name" TEXT,
    "worktreePath" TEXT,
    "executionTarget" TEXT,
    "status" TEXT NOT NULL,
    "latestConfigOptions" JSONB,
    "latestUsage" JSONB,
    "recoveryDetail" TEXT,
    "closedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "agentIssueRecordId" TEXT,
    CONSTRAINT "RuntimeSession_agentIssueRecordId_fkey" FOREIGN KEY ("agentIssueRecordId") REFERENCES "AgentIssueRecord" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RuntimeEventCursor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeSessionId" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "sourceCursor" TEXT,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RuntimeEventCursor_runtimeSessionId_fkey" FOREIGN KEY ("runtimeSessionId") REFERENCES "RuntimeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeSession_scopeKey_key" ON "RuntimeSession"("scopeKey");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeSession_acpxRecordId_key" ON "RuntimeSession"("acpxRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeSession_acpxSessionId_key" ON "RuntimeSession"("acpxSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeSession_agentIssueRecordId_key" ON "RuntimeSession"("agentIssueRecordId");

-- CreateIndex
CREATE INDEX "RuntimeSession_status_idx" ON "RuntimeSession"("status");

-- CreateIndex
CREATE INDEX "RuntimeSession_agentCommand_cwd_idx" ON "RuntimeSession"("agentCommand", "cwd");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeEventCursor_runtimeSessionId_consumer_key" ON "RuntimeEventCursor"("runtimeSessionId", "consumer");
