CREATE TABLE "RuntimeSourceMessageResolution" (
  "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
  "id" TEXT NOT NULL,
  "sourceMessageId" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "authorityRef" TEXT,
  "sessionId" TEXT,
  "externalOwner" JSONB,
  "outcome" TEXT,
  "evidence" JSONB NOT NULL,
  "revisionSequence" INTEGER,
  "priorReplyId" TEXT,
  "priorReplyBody" TEXT,
  "priorReplyPosted" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RuntimeSourceMessageResolution_sourceMessageId_fkey" FOREIGN KEY ("sourceMessageId") REFERENCES "RuntimeSourceMessage" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RuntimeSourceMessageResolution_id_key" ON "RuntimeSourceMessageResolution"("id");
CREATE UNIQUE INDEX "RuntimeSourceMessageResolution_sourceMessageId_requestKey_key" ON "RuntimeSourceMessageResolution"("sourceMessageId", "requestKey");
CREATE UNIQUE INDEX "RuntimeSourceMessageResolution_priorReplyId_key" ON "RuntimeSourceMessageResolution"("priorReplyId");
CREATE INDEX "RuntimeSourceMessageResolution_sourceMessageId_sequence_idx" ON "RuntimeSourceMessageResolution"("sourceMessageId", "sequence");
