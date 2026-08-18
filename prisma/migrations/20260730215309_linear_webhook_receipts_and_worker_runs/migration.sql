-- Split the former Delivery audit row into webhook intake and worker execution
-- records. Existing primary keys remain stable as receipt IDs.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "LinearWebhookReceipt" (
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

CREATE TABLE "WorkerRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "receiptId" TEXT NOT NULL,
    "workerKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "detail" TEXT,
    "targetSessionIdentifier" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorkerRun_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "LinearWebhookReceipt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

INSERT INTO "LinearWebhookReceipt" (
    "id",
    "linearDeliveryId",
    "eventType",
    "trigger",
    "sourceIssueIdentifier",
    "sourceCommentId",
    "status",
    "detail",
    "createdAt",
    "updatedAt"
)
SELECT
    "deliveryId",
    "deliveryId",
    CASE "eventType"
      WHEN 'mention' THEN 'comment'
      WHEN 'reflection' THEN 'issue'
      ELSE "eventType"
    END,
    CASE
      WHEN "eventType" IN ('mention', 'reflection') THEN "eventType"
      ELSE NULL
    END,
    "issueIdentifier",
    "commentId",
    CASE WHEN "outcome" = 'ignored' THEN 'ignored' ELSE 'accepted' END,
    CASE WHEN "outcome" = 'ignored' THEN "detail" ELSE NULL END,
    "createdAt",
    "updatedAt"
FROM "Delivery";

INSERT INTO "WorkerRun" (
    "id",
    "receiptId",
    "workerKey",
    "status",
    "attempts",
    "detail",
    "targetSessionIdentifier",
    "createdAt",
    "updatedAt"
)
SELECT
    "deliveryId" || ':' ||
      CASE "eventType"
        WHEN 'reflection' THEN 'product.reflection'
        ELSE 'product.agent-mention'
      END,
    "deliveryId",
    CASE "eventType"
      WHEN 'reflection' THEN 'product.reflection'
      ELSE 'product.agent-mention'
    END,
    "outcome",
    CASE WHEN "outcome" = 'pending' THEN 0 ELSE 1 END,
    "detail",
    "targetAgentIssue",
    "createdAt",
    "updatedAt"
FROM "Delivery"
WHERE "outcome" <> 'ignored';

DROP TABLE "Delivery";

CREATE UNIQUE INDEX "LinearWebhookReceipt_linearDeliveryId_key" ON "LinearWebhookReceipt"("linearDeliveryId");
CREATE INDEX "LinearWebhookReceipt_sourceIssueIdentifier_idx" ON "LinearWebhookReceipt"("sourceIssueIdentifier");
CREATE INDEX "LinearWebhookReceipt_createdAt_idx" ON "LinearWebhookReceipt"("createdAt");
CREATE INDEX "WorkerRun_receiptId_idx" ON "WorkerRun"("receiptId");
CREATE INDEX "WorkerRun_createdAt_idx" ON "WorkerRun"("createdAt");
CREATE UNIQUE INDEX "WorkerRun_receiptId_workerKey_key" ON "WorkerRun"("receiptId", "workerKey");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
