CREATE TABLE "RuntimeIssueUpdate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeSessionId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "evidence" JSONB NOT NULL,
    "commentPosted" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RuntimeIssueUpdate_runtimeSessionId_fkey" FOREIGN KEY ("runtimeSessionId") REFERENCES "RuntimeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RuntimeIssueUpdate_runtimeSessionId_requestKey_key" ON "RuntimeIssueUpdate"("runtimeSessionId", "requestKey");
