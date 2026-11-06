-- CreateTable
CREATE TABLE "ToolingRelease" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "tree" TEXT NOT NULL,
    "policyBlob" TEXT NOT NULL,
    "checkout" TEXT NOT NULL,
    "manifest" JSONB NOT NULL,
    "lockfileDigest" TEXT NOT NULL,
    "bunVersion" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ToolingSelection" (
    "repositoryId" TEXT NOT NULL PRIMARY KEY,
    "generation" INTEGER NOT NULL,
    "releaseId" TEXT NOT NULL,
    "activatedAt" DATETIME NOT NULL,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ToolingActivation" (
    "requestKey" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "revision" TEXT NOT NULL,
    "expectedGeneration" INTEGER NOT NULL,
    "releaseId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ToolingOperation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "inputDigest" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "turnId" TEXT,
    "existingOperationId" TEXT,
    "parentOperationId" TEXT,
    "retainedConsumerId" TEXT,
    "resourceKey" TEXT,
    "generation" INTEGER NOT NULL,
    "releaseId" TEXT NOT NULL,
    "protocol" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'bound',
    "completionEvidence" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ToolingStateWrite" (
    "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "repositoryId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "family" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "preservesUnknown" BOOLEAN NOT NULL,
    "operationId" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ToolingLegacyBoundary" (
    "repositoryId" TEXT NOT NULL PRIMARY KEY,
    "activationRequestKey" TEXT NOT NULL,
    "legacyRevision" TEXT,
    "recordedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ToolingLegacyConsumer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "consumerKind" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "provenance" TEXT NOT NULL,
    "revision" TEXT,
    "checkout" TEXT,
    "receipt" JSONB,
    "detail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'retained',
    "resolution" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ToolingRetainedConsumer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "operationId" TEXT NOT NULL,
    "repositoryId" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "consumerKind" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "protocol" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "evidence" JSONB,
    "resolution" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "confirmedAt" DATETIME,
    "resolvedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolingRelease_repositoryId_revision_key" ON "ToolingRelease"("repositoryId", "revision");

-- CreateIndex
CREATE INDEX "ToolingActivation_repositoryId_generation_idx" ON "ToolingActivation"("repositoryId", "generation");

-- CreateIndex
CREATE INDEX "ToolingOperation_parentOperationId_idx" ON "ToolingOperation"("parentOperationId");

-- CreateIndex
CREATE INDEX "ToolingOperation_retainedConsumerId_idx" ON "ToolingOperation"("retainedConsumerId");

-- CreateIndex
CREATE INDEX "ToolingOperation_releaseId_status_idx" ON "ToolingOperation"("releaseId", "status");

-- CreateIndex
CREATE INDEX "ToolingOperation_repositoryId_status_idx" ON "ToolingOperation"("repositoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ToolingOperation_taskId_requestKey_key" ON "ToolingOperation"("taskId", "requestKey");

-- CreateIndex
CREATE INDEX "ToolingStateWrite_taskId_family_scopeKey_sequence_idx" ON "ToolingStateWrite"("taskId", "family", "scopeKey", "sequence");

-- CreateIndex
CREATE INDEX "ToolingStateWrite_repositoryId_family_idx" ON "ToolingStateWrite"("repositoryId", "family");

-- CreateIndex
CREATE UNIQUE INDEX "ToolingStateWrite_operationId_family_scopeKey_version_key" ON "ToolingStateWrite"("operationId", "family", "scopeKey", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ToolingLegacyBoundary_activationRequestKey_key" ON "ToolingLegacyBoundary"("activationRequestKey");

-- CreateIndex
CREATE INDEX "ToolingLegacyConsumer_taskId_status_idx" ON "ToolingLegacyConsumer"("taskId", "status");

-- CreateIndex
CREATE INDEX "ToolingLegacyConsumer_repositoryId_status_idx" ON "ToolingLegacyConsumer"("repositoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ToolingLegacyConsumer_repositoryId_consumerKind_consumerId_key" ON "ToolingLegacyConsumer"("repositoryId", "consumerKind", "consumerId");

-- CreateIndex
CREATE INDEX "ToolingRetainedConsumer_taskId_status_idx" ON "ToolingRetainedConsumer"("taskId", "status");

-- CreateIndex
CREATE INDEX "ToolingRetainedConsumer_taskId_consumerKind_consumerId_status_idx" ON "ToolingRetainedConsumer"("taskId", "consumerKind", "consumerId", "status");

-- CreateIndex
CREATE INDEX "ToolingRetainedConsumer_repositoryId_status_idx" ON "ToolingRetainedConsumer"("repositoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ToolingRetainedConsumer_operationId_consumerKind_consumerId_key" ON "ToolingRetainedConsumer"("operationId", "consumerKind", "consumerId");

