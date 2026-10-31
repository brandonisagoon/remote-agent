CREATE TABLE "ComputeEnvironment" (
  "id" TEXT NOT NULL PRIMARY KEY, "taskId" TEXT NOT NULL, "primarySessionId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL, "key" TEXT NOT NULL, "purpose" TEXT NOT NULL, "revision" TEXT NOT NULL,
  "recipeDigest" TEXT NOT NULL, "taskIdentity" TEXT NOT NULL, "state" TEXT NOT NULL DEFAULT 'waiting',
  "resourceId" TEXT, "resourceIdentity" TEXT, "configuration" JSONB, "observation" JSONB, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ComputeEnvironment_taskId_key_key" ON "ComputeEnvironment"("taskId", "key");
CREATE INDEX "ComputeEnvironment_machineId_state_idx" ON "ComputeEnvironment"("machineId", "state");
CREATE TABLE "ComputeWait" (
  "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "environmentId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL, "eligibleAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ComputeWait_environmentId_key" ON "ComputeWait"("environmentId");
CREATE INDEX "ComputeWait_machineId_sequence_idx" ON "ComputeWait"("machineId", "sequence");
CREATE TABLE "ComputeOffer" (
  "id" TEXT NOT NULL PRIMARY KEY, "environmentId" TEXT NOT NULL, "machineId" TEXT NOT NULL,
  "instructionId" TEXT NOT NULL, "executionRequestId" TEXT, "state" TEXT NOT NULL DEFAULT 'queued',
  "dispatchDeadline" DATETIME NOT NULL, "deliveredAt" DATETIME, "expiresAt" DATETIME,
  "claimedAt" DATETIME, "completedAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ComputeOffer_instructionId_key" ON "ComputeOffer"("instructionId");
CREATE INDEX "ComputeOffer_environmentId_state_idx" ON "ComputeOffer"("environmentId", "state");
CREATE INDEX "ComputeOffer_machineId_state_idx" ON "ComputeOffer"("machineId", "state");
CREATE TABLE "ComputeSlot" (
  "id" TEXT NOT NULL PRIMARY KEY, "machineId" TEXT NOT NULL, "ordinal" INTEGER NOT NULL,
  "allocationId" TEXT
);
CREATE UNIQUE INDEX "ComputeSlot_allocationId_key" ON "ComputeSlot"("allocationId");
CREATE UNIQUE INDEX "ComputeSlot_machineId_ordinal_key" ON "ComputeSlot"("machineId", "ordinal");
CREATE TABLE "ComputeTraffic" (
  "routeId" TEXT NOT NULL PRIMARY KEY, "environmentId" TEXT NOT NULL, "taskId" TEXT NOT NULL,
  "epoch" TEXT NOT NULL, "sequence" INTEGER NOT NULL DEFAULT 0, "state" JSONB NOT NULL,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "ComputeTraffic_environmentId_idx" ON "ComputeTraffic"("environmentId");
