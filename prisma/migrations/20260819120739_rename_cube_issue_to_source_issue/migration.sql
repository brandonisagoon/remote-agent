-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LinearWebhookReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "linearDeliveryId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "trigger" TEXT,
    "sourceIssueIdentifier" TEXT,
    "sourceCommentId" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_LinearWebhookReceipt" ("createdAt", "detail", "eventType", "id", "linearDeliveryId", "sourceCommentId", "sourceIssueIdentifier", "status", "trigger", "updatedAt") SELECT "createdAt", "detail", "eventType", "id", "linearDeliveryId", "sourceCommentId", "cubeIssueIdentifier", "status", "trigger", "updatedAt" FROM "LinearWebhookReceipt";
DROP TABLE "LinearWebhookReceipt";
ALTER TABLE "new_LinearWebhookReceipt" RENAME TO "LinearWebhookReceipt";
CREATE UNIQUE INDEX "LinearWebhookReceipt_linearDeliveryId_key" ON "LinearWebhookReceipt"("linearDeliveryId");
CREATE INDEX "LinearWebhookReceipt_sourceIssueIdentifier_idx" ON "LinearWebhookReceipt"("sourceIssueIdentifier");
CREATE INDEX "LinearWebhookReceipt_createdAt_idx" ON "LinearWebhookReceipt"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
