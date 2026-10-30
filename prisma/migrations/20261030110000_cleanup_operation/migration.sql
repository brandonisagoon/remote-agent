CREATE UNIQUE INDEX "RuntimeMetadataEvent_cleanup_operation_key"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key")
WHERE "action" = 'finalization-cleanup-started';
