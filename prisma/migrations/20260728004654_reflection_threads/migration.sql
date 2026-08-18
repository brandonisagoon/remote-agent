-- AlterTable
ALTER TABLE "AgentSession" ADD COLUMN "closedAt" DATETIME;
ALTER TABLE "AgentSession" ADD COLUMN "reflectionRequestedAt" DATETIME;
ALTER TABLE "AgentSession" ADD COLUMN "reflectionThreadRootId" TEXT;
ALTER TABLE "AgentSession" ADD COLUMN "transcript" TEXT;
