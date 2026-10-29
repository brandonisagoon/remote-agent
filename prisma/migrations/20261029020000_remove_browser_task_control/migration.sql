-- Preserve explicit owner pauses separately from removed browser takeover state.
ALTER TABLE "RemoteTask" ADD COLUMN "ownerPaused" BOOLEAN NOT NULL DEFAULT false;
UPDATE "RemoteTask" SET "ownerPaused" = true
WHERE "controllerId" = 'task-supervisor:' || "id" AND "controlMode" != 'agent' AND "phase" != 'closed';
-- Browser takeover no longer governs task execution.
ALTER TABLE "RemoteTask" DROP COLUMN "controlMode";
ALTER TABLE "RemoteTask" DROP COLUMN "controllerId";
ALTER TABLE "RemoteTask" DROP COLUMN "controlGeneration";
