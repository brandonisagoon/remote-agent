-- One immutable retained inventory per original primary/task. A new request key
-- cannot broaden it. Each resource receives at most one confirmation receipt.
CREATE UNIQUE INDEX "RuntimeMetadataEvent_legacy_evidence_retention_key"
ON "RuntimeMetadataEvent"("runtimeSessionId", "source")
WHERE "action" = 'legacy-evidence-retained';

CREATE UNIQUE INDEX "RuntimeMetadataEvent_legacy_evidence_confirmation_key"
ON "RuntimeMetadataEvent"("runtimeSessionId", "source", "key")
WHERE "action" = 'legacy-evidence-confirmed';
