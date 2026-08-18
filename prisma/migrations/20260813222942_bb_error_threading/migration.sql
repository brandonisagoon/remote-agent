-- AlterTable
ALTER TABLE "AgentIssueRecord" ADD COLUMN "lastErrorAt" DATETIME;
ALTER TABLE "AgentIssueRecord" ADD COLUMN "lastErrorCommentId" TEXT;
ALTER TABLE "AgentIssueRecord" ADD COLUMN "lastErrorEventId" TEXT;
ALTER TABLE "AgentIssueRecord" ADD COLUMN "lastErrorTurnId" TEXT;
ALTER TABLE "AgentIssueRecord" ADD COLUMN "sessionRootCommentId" TEXT;
