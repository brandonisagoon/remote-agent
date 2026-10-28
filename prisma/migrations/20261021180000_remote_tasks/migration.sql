CREATE TABLE "RemoteTask" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "requestKey" TEXT NOT NULL,
  "repositoryId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "connectionId" TEXT,
  "issueIdentifier" TEXT,
  "branchName" TEXT NOT NULL,
  "baseCommit" TEXT,
  "worktreePath" TEXT,
  "toolingRoot" TEXT NOT NULL,
  "toolingRevision" TEXT NOT NULL,
  "pinnedToolingRoot" TEXT,
  "primarySessionId" TEXT,
  "phase" TEXT NOT NULL DEFAULT 'preparing',
  "environmentStatus" TEXT NOT NULL DEFAULT 'pending',
  "controlMode" TEXT NOT NULL DEFAULT 'agent',
  "controllerId" TEXT,
  "controlGeneration" INTEGER NOT NULL DEFAULT 0,
  "recoveryDetail" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "RemoteTask_requestKey_key" ON "RemoteTask"("requestKey");
CREATE UNIQUE INDEX "RemoteTask_primarySessionId_key" ON "RemoteTask"("primarySessionId");
CREATE UNIQUE INDEX "RemoteTask_worktreePath_key" ON "RemoteTask"("worktreePath");
CREATE INDEX "RemoteTask_repositoryId_phase_idx" ON "RemoteTask"("repositoryId", "phase");
CREATE INDEX "RemoteTask_machineId_phase_idx" ON "RemoteTask"("machineId", "phase");
CREATE TABLE "RemoteTaskResource" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'allocated',
  "metadata" JSONB,
  "expiresAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "RemoteTaskResource_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "RemoteTask" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RemoteTaskResource_taskId_key_key" ON "RemoteTaskResource"("taskId", "key");
CREATE INDEX "RemoteTaskResource_state_expiresAt_idx" ON "RemoteTaskResource"("state", "expiresAt");
