-- Freeze each source revision's publication and confirmation independently.
CREATE UNIQUE INDEX "RuntimeMetadataEvent_cleanup_resume_key"
ON "RuntimeMetadataEvent"("runtimeSessionId", "source", "key")
WHERE "action" = 'completion-cleanup-resume';

CREATE UNIQUE INDEX "RuntimeMetadataEvent_cleanup_resume_confirmation_key"
ON "RuntimeMetadataEvent"("runtimeSessionId", "source", "key")
WHERE "action" = 'completion-cleanup-resume-confirmed';
