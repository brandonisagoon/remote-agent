CREATE TABLE "RuntimeQuestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runtimeSessionId" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RuntimeQuestion_runtimeSessionId_fkey" FOREIGN KEY ("runtimeSessionId") REFERENCES "RuntimeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "RuntimeQuestion_runtimeSessionId_requestKey_key" ON "RuntimeQuestion"("runtimeSessionId", "requestKey");
