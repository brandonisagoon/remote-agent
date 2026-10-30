CREATE UNIQUE INDEX "finalization_preparation_request_identity"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "action", "key")
WHERE "action" IN ('finalization-preparation-request', 'finalization-preparation-accepted');

CREATE INDEX "finalization_preparation_pending" ON "RuntimeMetadataEvent" ("action", "sequence")
WHERE "action" = 'finalization-preparation-accepted';
CREATE INDEX "finalization_preparation_progress" ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key", "sequence")
WHERE "action" = 'finalization-preparation-status';
