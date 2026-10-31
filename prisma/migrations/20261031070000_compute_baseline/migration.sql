CREATE TABLE "ComputeBaseline" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "machineId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "resourceIds" JSONB NOT NULL,
  "refreshToken" TEXT NOT NULL,
  "proof" JSONB,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "ComputeBaseline_machineId_taskId_purpose_key" ON "ComputeBaseline"("machineId", "taskId", "purpose");
CREATE INDEX "ComputeBaseline_machineId_idx" ON "ComputeBaseline"("machineId");
