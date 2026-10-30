CREATE UNIQUE INDEX "RuntimeMetadataEvent_cleanup_report_key"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key")
WHERE "action" = 'finalization-cleanup-report';
