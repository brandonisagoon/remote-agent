-- One immutable retained-evidence supplement for the existing cleanup operation.
CREATE UNIQUE INDEX "RuntimeMetadataEvent_cleanup_evidence_supplement_key"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key")
WHERE "action" = 'finalization-cleanup-evidence-supplement';
