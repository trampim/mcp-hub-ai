-- AlterTable: add columns that were added to the EntraGroup model after the initial migration
ALTER TABLE "EntraGroup" ADD COLUMN IF NOT EXISTS "memberCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "EntraGroup" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "EntraGroup" ADD COLUMN IF NOT EXISTS "lastSyncedAt" TIMESTAMP(3);
