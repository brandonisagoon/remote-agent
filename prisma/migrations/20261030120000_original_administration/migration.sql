CREATE UNIQUE INDEX "RuntimeMetadataEvent_original_administration_key"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key")
WHERE "action" = 'finalization-original-administration';
