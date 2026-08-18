-- DropIndex
DROP INDEX "SessionIssue_machine_tmuxPane_idx";

-- DropIndex
DROP INDEX "SessionIssue_harnessSessionId_key";

-- RenameTable
ALTER TABLE "SessionIssue" RENAME TO "AgentIssueRecord";

-- RenameColumn
ALTER TABLE "AgentIssueRecord" RENAME COLUMN "linearIssueId" TO "agentIssueId";

-- RenameColumn
ALTER TABLE "AgentIssueRecord" RENAME COLUMN "linearIssueIdentifier" TO "agentIssueIdentifier";

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LinearWebhookReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "linearDeliveryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "trigger" TEXT,
    "cubeIssueIdentifier" TEXT,
    "sourceCommentId" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_LinearWebhookReceipt" ("createdAt", "cubeIssueIdentifier", "detail", "eventType", "id", "linearDeliveryId", "sourceCommentId", "status", "trigger", "updatedAt") SELECT "createdAt", "sourceIssueIdentifier", "detail", "eventType", "id", "linearDeliveryId", "sourceCommentId", "status", "trigger", "updatedAt" FROM "LinearWebhookReceipt";
DROP TABLE "LinearWebhookReceipt";
ALTER TABLE "new_LinearWebhookReceipt" RENAME TO "LinearWebhookReceipt";
CREATE UNIQUE INDEX "LinearWebhookReceipt_linearDeliveryId_key" ON "LinearWebhookReceipt"("linearDeliveryId");
CREATE INDEX "LinearWebhookReceipt_cubeIssueIdentifier_idx" ON "LinearWebhookReceipt"("cubeIssueIdentifier");
CREATE INDEX "LinearWebhookReceipt_createdAt_idx" ON "LinearWebhookReceipt"("createdAt");
CREATE TABLE "new_WorkerRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptId" TEXT NOT NULL,
    "workerKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "targetAgentIssueIdentifier" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkerRun_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "LinearWebhookReceipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_WorkerRun" ("attempts", "createdAt", "detail", "id", "receiptId", "status", "targetAgentIssueIdentifier", "updatedAt", "workerKey") SELECT "attempts", "createdAt", "detail", "id", "receiptId", "status", "targetSessionIdentifier", "updatedAt", "workerKey" FROM "WorkerRun";
DROP TABLE "WorkerRun";
ALTER TABLE "new_WorkerRun" RENAME TO "WorkerRun";
CREATE INDEX "WorkerRun_receiptId_idx" ON "WorkerRun"("receiptId");
CREATE INDEX "WorkerRun_createdAt_idx" ON "WorkerRun"("createdAt");
CREATE UNIQUE INDEX "WorkerRun_receiptId_workerKey_key" ON "WorkerRun"("receiptId", "workerKey");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AgentIssueRecord_harnessSessionId_key" ON "AgentIssueRecord"("harnessSessionId");

-- CreateIndex
CREATE INDEX "AgentIssueRecord_machine_tmuxPane_idx" ON "AgentIssueRecord"("machine", "tmuxPane");
