-- CreateTable
CREATE TABLE "AgentSession" (
    "issueIdentifier" TEXT NOT NULL PRIMARY KEY,
    "issueId" TEXT,
    "branchName" TEXT NOT NULL,
    "worktreePath" TEXT NOT NULL,
    "harness" TEXT NOT NULL,
    "lastTmuxSession" TEXT,
    "state" TEXT NOT NULL DEFAULT 'registered',
    "gateThreadRootId" TEXT,
    "gatePhrase" TEXT,
    "gatePrompt" TEXT,
    "gateConsumedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Delivery" (
    "deliveryId" TEXT NOT NULL PRIMARY KEY,
    "issueIdentifier" TEXT,
    "commentId" TEXT,
    "authorId" TEXT,
    "body" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'mention',
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "targetSession" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "AgentSession_branchName_idx" ON "AgentSession"("branchName");

-- CreateIndex
CREATE INDEX "AgentSession_worktreePath_idx" ON "AgentSession"("worktreePath");

-- CreateIndex
CREATE INDEX "Delivery_issueIdentifier_idx" ON "Delivery"("issueIdentifier");

-- CreateIndex
CREATE INDEX "Delivery_createdAt_idx" ON "Delivery"("createdAt");
