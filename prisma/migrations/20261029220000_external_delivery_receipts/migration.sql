-- New supplemental receipt identities are immutable across concurrent callers.
-- Historical event semantics and v1 receipts remain unchanged.
CREATE UNIQUE INDEX "RuntimeMetadataEvent_external_receipt_identity"
ON "RuntimeMetadataEvent"("runtimeSessionId", "action", "source", "key")
WHERE "action" IN ('external-delivery-binding', 'external-delivery-observation', 'finalization-resource-proof');
