-- One immutable transport transition from each observed prior revision.
CREATE UNIQUE INDEX "RuntimeMetadataEvent_cleanup_provider_transport_key"
ON "RuntimeMetadataEvent" ("runtimeSessionId", "source", "key")
WHERE "action" = 'cleanup-provider-transport';
