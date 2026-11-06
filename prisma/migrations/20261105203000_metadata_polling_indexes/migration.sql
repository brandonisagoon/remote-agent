-- Receipt lookups must not scan large unrelated history values.
CREATE INDEX IF NOT EXISTS "RuntimeMetadataEvent_action_source_key_sequence_idx"
ON "RuntimeMetadataEvent" ("action", "source", "key", "sequence");

-- Keep periodic finalization reconciliation on the index: completed status
-- receipts can contain multi-megabyte results that need not be decoded again.
CREATE INDEX IF NOT EXISTS "finalization_preparation_terminal_state"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key", json_extract("value", '$.state'))
WHERE "action" = 'finalization-preparation-status';
