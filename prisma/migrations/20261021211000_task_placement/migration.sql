CREATE TABLE "TaskPlacement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sourceKey" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "taskId" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "TaskPlacement_sourceKey_key" ON "TaskPlacement"("sourceKey");
CREATE TABLE "TaskDelivery" (
  "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "id" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "placementId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "retryAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "detail" TEXT,
  "response" JSONB,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "TaskDelivery_placementId_fkey" FOREIGN KEY ("placementId") REFERENCES "TaskPlacement"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "TaskDelivery_id_key" ON "TaskDelivery"("id");
CREATE UNIQUE INDEX "TaskDelivery_requestKey_key" ON "TaskDelivery"("requestKey");
CREATE INDEX "TaskDelivery_state_retryAt_idx" ON "TaskDelivery"("state", "retryAt");
CREATE INDEX "TaskDelivery_placementId_sequence_idx" ON "TaskDelivery"("placementId", "sequence");
