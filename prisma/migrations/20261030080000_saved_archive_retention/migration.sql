-- One immutable supplement per original primary/task. Retrying finalization
-- cannot create a second archive inventory or replace the original preparation.
CREATE UNIQUE INDEX "RuntimeMetadataEvent_saved_archive_retention_key"
ON "RuntimeMetadataEvent"("runtimeSessionId", "source")
WHERE "action" = 'finalization-archive-retention';
