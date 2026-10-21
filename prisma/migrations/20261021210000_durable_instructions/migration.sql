CREATE TABLE "RuntimeInstruction" (
  "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "id" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'queued',
  "detail" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "RuntimeInstruction_id_key" ON "RuntimeInstruction"("id");
CREATE INDEX "RuntimeInstruction_sessionId_state_createdAt_idx" ON "RuntimeInstruction"("sessionId", "state", "createdAt");
-- Preserve existing launch identity without replaying pre-inbox prompts.
INSERT INTO "RuntimeInstruction" ("id", "sessionId", "text", "state", "detail", "updatedAt")
SELECT 'launch:' || "requestKey", "primarySessionId", '', 'legacy', 'Created before the durable inbox. Existing transcript remains authoritative.', CURRENT_TIMESTAMP
FROM "RemoteTask" WHERE "primarySessionId" IS NOT NULL;
