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
CREATE TABLE "ToolingPendingActivation" (
    "repositoryId" TEXT NOT NULL PRIMARY KEY,
    "requestKey" TEXT NOT NULL,
    "releaseId" TEXT NOT NULL,
    "expectedGeneration" INTEGER NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "promotedAt" DATETIME
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
    "resourceKey" TEXT,
    "generation" INTEGER NOT NULL,
    "releaseId" TEXT NOT NULL,
    "protocol" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'bound',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "ToolingRelease_repositoryId_revision_key" ON "ToolingRelease"("repositoryId", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "ToolingPendingActivation_requestKey_key" ON "ToolingPendingActivation"("requestKey");

-- CreateIndex
CREATE INDEX "ToolingActivation_repositoryId_generation_idx" ON "ToolingActivation"("repositoryId", "generation");

-- CreateIndex
CREATE INDEX "ToolingOperation_releaseId_status_idx" ON "ToolingOperation"("releaseId", "status");

-- CreateIndex
CREATE INDEX "ToolingOperation_repositoryId_status_idx" ON "ToolingOperation"("repositoryId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ToolingOperation_taskId_requestKey_key" ON "ToolingOperation"("taskId", "requestKey");

