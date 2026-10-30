ALTER TABLE "RuntimeInstruction" ADD COLUMN "sourceMessageId" TEXT;
ALTER TABLE "RuntimeInstruction" ADD COLUMN "executionRequestId" TEXT;
CREATE UNIQUE INDEX "RuntimeInstruction_sourceMessageId_key" ON "RuntimeInstruction"("sourceMessageId");
CREATE TABLE "RuntimeSourceMessage" (
 "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
 "id" TEXT NOT NULL,
 "provider" TEXT NOT NULL,
 "connectionId" TEXT NOT NULL,
 "repositoryId" TEXT NOT NULL,
 "machineId" TEXT NOT NULL,
 "resourceId" TEXT NOT NULL,
 "resourceIdentifier" TEXT NOT NULL,
 "commentId" TEXT NOT NULL,
 "threadRootId" TEXT NOT NULL,
 "authorId" TEXT NOT NULL,
 "body" TEXT NOT NULL,
 "presentation" JSONB NOT NULL,
 "requestedActions" JSONB NOT NULL DEFAULT '[]',
 "sessionId" TEXT,
 "requestId" TEXT,
 "targetRequestId" TEXT,
 "state" TEXT NOT NULL DEFAULT 'routing',
 "detail" TEXT,
 "replyId" TEXT NOT NULL,
 "replyBody" TEXT,
 "replyRequestKey" TEXT,
 "replyPosted" BOOLEAN NOT NULL DEFAULT false,
 "projectionPending" BOOLEAN NOT NULL DEFAULT true,
 "projectedReactions" JSONB NOT NULL DEFAULT '[]',
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "RuntimeSourceMessage_id_key" ON "RuntimeSourceMessage"("id");
CREATE UNIQUE INDEX "RuntimeSourceMessage_replyId_key" ON "RuntimeSourceMessage"("replyId");
CREATE INDEX "RuntimeSourceMessage_provider_connectionId_commentId_sequence_idx" ON "RuntimeSourceMessage"("provider", "connectionId", "commentId", "sequence");
CREATE INDEX "RuntimeSourceMessage_sessionId_requestId_idx" ON "RuntimeSourceMessage"("sessionId", "requestId");
CREATE TABLE "RuntimeMessageControl" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "provider" TEXT NOT NULL,
 "connectionId" TEXT NOT NULL,
 "repositoryId" TEXT NOT NULL,
 "machineId" TEXT NOT NULL,
 "commentId" TEXT NOT NULL,
 "authorId" TEXT NOT NULL,
 "state" TEXT NOT NULL DEFAULT 'pending',
 "detail" TEXT,
 "sourceMessageId" TEXT,
 "noticeId" TEXT NOT NULL,
 "noticeBody" TEXT,
 "noticePosted" BOOLEAN NOT NULL DEFAULT false,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "RuntimeMessageControl_state_createdAt_idx" ON "RuntimeMessageControl"("state", "createdAt");
CREATE UNIQUE INDEX "RuntimeMessageControl_noticeId_key" ON "RuntimeMessageControl"("noticeId");
