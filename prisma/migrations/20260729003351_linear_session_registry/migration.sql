/*
  Warnings:

  - You are about to drop the `AgentSession` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `authorId` on the `Delivery` table. All the data in the column will be lost.
  - You are about to drop the column `body` on the `Delivery` table. All the data in the column will be lost.
  - You are about to drop the column `kind` on the `Delivery` table. All the data in the column will be lost.
  - You are about to drop the column `targetSession` on the `Delivery` table. All the data in the column will be lost.
  Existing Delivery rows retain their former `kind` as `eventType`, and their
  `createdAt` value initializes `updatedAt`.

*/
-- DropIndex
DROP INDEX "AgentSession_reflectionThreadRootId_idx";

-- DropIndex
DROP INDEX "AgentSession_gateThreadRootId_idx";

-- DropIndex
DROP INDEX "AgentSession_worktreePath_idx";

-- DropIndex
DROP INDEX "AgentSession_branchName_idx";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "AgentSession";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Delivery" (
    "deliveryId" TEXT NOT NULL PRIMARY KEY,
    "eventType" TEXT NOT NULL,
    "issueIdentifier" TEXT,
    "commentId" TEXT,
    "targetAgentIssue" TEXT,
    "outcome" TEXT NOT NULL,
    "detail" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Delivery" ("commentId", "createdAt", "deliveryId", "detail", "eventType", "issueIdentifier", "outcome", "updatedAt")
SELECT "commentId", "createdAt", "deliveryId", "detail", "kind", "issueIdentifier", "outcome", "createdAt" FROM "Delivery";
DROP TABLE "Delivery";
ALTER TABLE "new_Delivery" RENAME TO "Delivery";
CREATE INDEX "Delivery_issueIdentifier_idx" ON "Delivery"("issueIdentifier");
CREATE INDEX "Delivery_createdAt_idx" ON "Delivery"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
