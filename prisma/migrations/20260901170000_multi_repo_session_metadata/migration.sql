ALTER TABLE "RuntimeSession" ADD COLUMN "repositoryId" TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE "RuntimeSession" ADD COLUMN "machineId" TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "RuntimeSession" ADD COLUMN "role" TEXT;
ALTER TABLE "RuntimeSession" ADD COLUMN "lifecycle" TEXT;
ALTER TABLE "RuntimeSession" ADD COLUMN "creationMetadataHash" TEXT;
ALTER TABLE "RuntimeSession" ADD COLUMN "metadataRevision" INTEGER NOT NULL DEFAULT 0;

UPDATE "RuntimeSession"
SET "machineId" = COALESCE("executionTarget", 'unknown');

CREATE TABLE "RuntimeSessionTag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeSessionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RuntimeSessionTag_runtimeSessionId_fkey" FOREIGN KEY ("runtimeSessionId") REFERENCES "RuntimeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "RuntimeSessionRelation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceSessionId" TEXT NOT NULL,
    "targetSessionId" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "RuntimeSessionRelation_sourceSessionId_fkey" FOREIGN KEY ("sourceSessionId") REFERENCES "RuntimeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "RuntimeSessionRelation_targetSessionId_fkey" FOREIGN KEY ("targetSessionId") REFERENCES "RuntimeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "RuntimeSessionResourceLink" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeSessionId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "relationship" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "RuntimeSessionResourceLink_runtimeSessionId_fkey" FOREIGN KEY ("runtimeSessionId") REFERENCES "RuntimeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "RuntimeMetadataEvent" (
    "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runtimeSessionId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT,
    "source" TEXT NOT NULL,
    "occurredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuntimeMetadataEvent_runtimeSessionId_fkey" FOREIGN KEY ("runtimeSessionId") REFERENCES "RuntimeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "RuntimeSession_repositoryId_status_idx" ON "RuntimeSession"("repositoryId", "status");
CREATE INDEX "RuntimeSession_machineId_status_idx" ON "RuntimeSession"("machineId", "status");
CREATE UNIQUE INDEX "RuntimeSessionTag_runtimeSessionId_key_value_key" ON "RuntimeSessionTag"("runtimeSessionId", "key", "value");
CREATE INDEX "RuntimeSessionTag_key_value_idx" ON "RuntimeSessionTag"("key", "value");
CREATE UNIQUE INDEX "RuntimeSessionRelation_sourceSessionId_targetSessionId_relationship_key" ON "RuntimeSessionRelation"("sourceSessionId", "targetSessionId", "relationship");
CREATE INDEX "RuntimeSessionRelation_targetSessionId_relationship_idx" ON "RuntimeSessionRelation"("targetSessionId", "relationship");
CREATE UNIQUE INDEX "RuntimeSessionResourceLink_runtimeSessionId_provider_connectionId_resourceType_externalId_relationship_key" ON "RuntimeSessionResourceLink"("runtimeSessionId", "provider", "connectionId", "resourceType", "externalId", "relationship");
CREATE INDEX "RuntimeSessionResourceLink_provider_connectionId_resourceType_externalId_idx" ON "RuntimeSessionResourceLink"("provider", "connectionId", "resourceType", "externalId");
CREATE INDEX "RuntimeMetadataEvent_runtimeSessionId_sequence_idx" ON "RuntimeMetadataEvent"("runtimeSessionId", "sequence");

PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_LinearWebhookReceipt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "linearDeliveryId" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL DEFAULT 'legacy',
    "connectionId" TEXT NOT NULL DEFAULT 'legacy',
    "repositoryId" TEXT NOT NULL DEFAULT 'legacy',
    "eventType" TEXT NOT NULL,
    "trigger" TEXT,
    "sourceIssueIdentifier" TEXT,
    "sourceCommentId" TEXT,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

INSERT INTO "new_LinearWebhookReceipt" ("id", "linearDeliveryId", "eventType", "trigger", "sourceIssueIdentifier", "sourceCommentId", "status", "detail", "createdAt", "updatedAt")
SELECT "id", "linearDeliveryId", "eventType", "trigger", "sourceIssueIdentifier", "sourceCommentId", "status", "detail", "createdAt", "updatedAt" FROM "LinearWebhookReceipt";

DROP TABLE "LinearWebhookReceipt";
ALTER TABLE "new_LinearWebhookReceipt" RENAME TO "LinearWebhookReceipt";

CREATE INDEX "LinearWebhookReceipt_sourceIssueIdentifier_idx" ON "LinearWebhookReceipt"("sourceIssueIdentifier");
CREATE INDEX "LinearWebhookReceipt_createdAt_idx" ON "LinearWebhookReceipt"("createdAt");
CREATE UNIQUE INDEX "LinearWebhookReceipt_webhookId_linearDeliveryId_key" ON "LinearWebhookReceipt"("webhookId", "linearDeliveryId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
