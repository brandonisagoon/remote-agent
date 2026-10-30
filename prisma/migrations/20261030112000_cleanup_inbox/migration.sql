CREATE UNIQUE INDEX "RuntimeMetadataEvent_cleanup_request_unique"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key")
WHERE "action" = 'finalization-cleanup-request';
CREATE UNIQUE INDEX "RuntimeMetadataEvent_cleanup_instruction_unique"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key")
WHERE "action" = 'finalization-cleanup-instruction';
