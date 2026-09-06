-- Vocabulary generalization: LinearWebhookReceipt -> WebhookReceipt,
-- AgentIssueRecord -> SessionMirror, WorkerRun.targetAgentIssueIdentifier ->
-- targetResourceId, RuntimeSession.agentIssueRecordId -> sessionMirrorId.
-- Hand-edited from Prisma's generated drop/create into data-preserving
-- copies. The final DDL matches the Prisma schema exactly.

-- CreateTable
CREATE TABLE "SessionMirror" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sessionKey" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'linear',
    "connectionId" TEXT NOT NULL DEFAULT 'legacy',
    "externalId" TEXT NOT NULL,
    "externalRef" TEXT,
    "machineId" TEXT,
    "lastEventId" TEXT,
    "lastGeneration" BIGINT,
    "rootCommentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "SessionMirror" ("id", "sessionKey", "externalId", "externalRef", "machineId", "lastEventId", "lastGeneration", "rootCommentId", "createdAt", "updatedAt")
SELECT "id", "harnessSessionId", "agentIssueId", "agentIssueIdentifier", "machine", "lastEventId", "lastGeneration", "sessionRootCommentId", "createdAt", "updatedAt" FROM "AgentIssueRecord";

-- CreateTable
CREATE TABLE "WebhookReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "provider" TEXT NOT NULL DEFAULT 'linear',
    "deliveryId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL DEFAULT 'legacy',
    "connectionId" TEXT NOT NULL DEFAULT 'legacy',
    "repositoryId" TEXT NOT NULL DEFAULT 'legacy',
    "eventType" TEXT NOT NULL,
    "trigger" TEXT,
    "resourceType" TEXT NOT NULL DEFAULT 'issue',
    "resourceId" TEXT,
    "commentId" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "WebhookReceipt" ("id", "deliveryId", "webhookId", "connectionId", "repositoryId", "eventType", "trigger", "resourceId", "commentId", "status", "detail", "createdAt", "updatedAt")
SELECT "id", "linearDeliveryId", "webhookId", "connectionId", "repositoryId", "eventType", "trigger", "sourceIssueIdentifier", "sourceCommentId", "status", "detail", "createdAt", "updatedAt" FROM "LinearWebhookReceipt";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RuntimeSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "scopeKey" TEXT NOT NULL,
    "acpxRecordId" TEXT,
    "acpxSessionId" TEXT,
    "agentSessionId" TEXT,
    "agentCommand" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL DEFAULT 'legacy',
    "machineId" TEXT NOT NULL DEFAULT 'unknown',
    "role" TEXT,
    "lifecycle" TEXT,
    "workflowId" TEXT,
    "creationMetadataHash" TEXT,
    "metadataRevision" INTEGER NOT NULL DEFAULT 0,
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
    "sessionMirrorId" TEXT,
    CONSTRAINT "RuntimeSession_sessionMirrorId_fkey" FOREIGN KEY ("sessionMirrorId") REFERENCES "SessionMirror" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_RuntimeSession" ("acpxRecordId", "acpxSessionId", "agentCommand", "agentSessionId", "closedAt", "createdAt", "creationMetadataHash", "cwd", "executionTarget", "id", "latestConfigOptions", "latestUsage", "lifecycle", "machineId", "metadataRevision", "name", "recoveryDetail", "repositoryId", "role", "scopeKey", "sessionMirrorId", "status", "updatedAt", "workflowId", "worktreePath") SELECT "acpxRecordId", "acpxSessionId", "agentCommand", "agentSessionId", "closedAt", "createdAt", "creationMetadataHash", "cwd", "executionTarget", "id", "latestConfigOptions", "latestUsage", "lifecycle", "machineId", "metadataRevision", "name", "recoveryDetail", "repositoryId", "role", "scopeKey", "agentIssueRecordId", "status", "updatedAt", "workflowId", "worktreePath" FROM "RuntimeSession";
DROP TABLE "RuntimeSession";
ALTER TABLE "new_RuntimeSession" RENAME TO "RuntimeSession";
CREATE UNIQUE INDEX "RuntimeSession_scopeKey_key" ON "RuntimeSession"("scopeKey");
CREATE UNIQUE INDEX "RuntimeSession_acpxRecordId_key" ON "RuntimeSession"("acpxRecordId");
CREATE UNIQUE INDEX "RuntimeSession_acpxSessionId_key" ON "RuntimeSession"("acpxSessionId");
CREATE UNIQUE INDEX "RuntimeSession_sessionMirrorId_key" ON "RuntimeSession"("sessionMirrorId");
CREATE INDEX "RuntimeSession_status_idx" ON "RuntimeSession"("status");
CREATE INDEX "RuntimeSession_agentCommand_cwd_idx" ON "RuntimeSession"("agentCommand", "cwd");
CREATE INDEX "RuntimeSession_repositoryId_status_idx" ON "RuntimeSession"("repositoryId", "status");
CREATE INDEX "RuntimeSession_machineId_status_idx" ON "RuntimeSession"("machineId", "status");
CREATE TABLE "new_WorkerRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptId" TEXT NOT NULL,
    "workerKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "targetResourceId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkerRun_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "WebhookReceipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorkerRun" ("attempts", "createdAt", "detail", "id", "receiptId", "status", "targetResourceId", "updatedAt", "workerKey") SELECT "attempts", "createdAt", "detail", "id", "receiptId", "status", "targetAgentIssueIdentifier", "updatedAt", "workerKey" FROM "WorkerRun";
DROP TABLE "WorkerRun";
ALTER TABLE "new_WorkerRun" RENAME TO "WorkerRun";
CREATE INDEX "WorkerRun_receiptId_idx" ON "WorkerRun"("receiptId");
CREATE INDEX "WorkerRun_createdAt_idx" ON "WorkerRun"("createdAt");
CREATE UNIQUE INDEX "WorkerRun_receiptId_workerKey_key" ON "WorkerRun"("receiptId", "workerKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AgentIssueRecord";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "LinearWebhookReceipt";
PRAGMA foreign_keys=on;

-- CreateIndex
CREATE UNIQUE INDEX "SessionMirror_sessionKey_key" ON "SessionMirror"("sessionKey");

-- CreateIndex
CREATE INDEX "SessionMirror_machineId_idx" ON "SessionMirror"("machineId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_resourceId_idx" ON "WebhookReceipt"("resourceId");

-- CreateIndex
CREATE INDEX "WebhookReceipt_createdAt_idx" ON "WebhookReceipt"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookReceipt_webhookId_deliveryId_key" ON "WebhookReceipt"("webhookId", "deliveryId");
