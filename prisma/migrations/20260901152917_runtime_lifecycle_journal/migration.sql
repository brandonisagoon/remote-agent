-- CreateTable
CREATE TABLE "RuntimeLifecycleEvent" (
    "sequence" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "id" TEXT NOT NULL,
    "runtimeSessionId" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "error" TEXT,
    "occurredAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RuntimeLifecycleEvent_runtimeSessionId_fkey" FOREIGN KEY ("runtimeSessionId") REFERENCES "RuntimeSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RuntimeLifecycleEvent_id_key" ON "RuntimeLifecycleEvent"("id");

-- CreateIndex
CREATE INDEX "RuntimeLifecycleEvent_runtimeSessionId_sequence_idx" ON "RuntimeLifecycleEvent"("runtimeSessionId", "sequence");
