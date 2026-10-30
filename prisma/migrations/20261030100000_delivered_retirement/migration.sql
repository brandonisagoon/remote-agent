CREATE UNIQUE INDEX "RuntimeMetadataEvent_done_retirement_key"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key")
WHERE "action" IN ('prepared-done-retirement', 'delivered-retirement-revoked');
