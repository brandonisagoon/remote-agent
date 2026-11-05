CREATE TABLE "NativeTakeover" (
 "id" TEXT NOT NULL PRIMARY KEY, "sourceKey" TEXT NOT NULL, "connectionId" TEXT NOT NULL, "repositoryId" TEXT NOT NULL,
 "machineId" TEXT NOT NULL, "issueId" TEXT NOT NULL, "issueIdentifier" TEXT NOT NULL, "revision" INTEGER NOT NULL,
 "mode" TEXT NOT NULL, "grantKey" TEXT, "grantedSessionId" TEXT, "settled" BOOLEAN NOT NULL DEFAULT false, "decidedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "NativeTakeover_sourceKey_key" ON "NativeTakeover"("sourceKey");
CREATE UNIQUE INDEX "NativeTakeover_connectionId_repositoryId_issueIdentifier_key" ON "NativeTakeover"("connectionId", "repositoryId", "issueIdentifier");
CREATE TABLE "NativeTakeoverEvent" (
 "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT, "controlId" TEXT NOT NULL, "requestKey" TEXT NOT NULL,
 "inputDigest" TEXT NOT NULL, "revision" INTEGER NOT NULL, "kind" TEXT NOT NULL, "value" JSONB NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "NativeTakeoverEvent_controlId_fkey" FOREIGN KEY ("controlId") REFERENCES "NativeTakeover"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "NativeTakeoverEvent_controlId_requestKey_key" ON "NativeTakeoverEvent"("controlId", "requestKey");
CREATE INDEX "NativeTakeoverEvent_controlId_sequence_idx" ON "NativeTakeoverEvent"("controlId", "sequence");
