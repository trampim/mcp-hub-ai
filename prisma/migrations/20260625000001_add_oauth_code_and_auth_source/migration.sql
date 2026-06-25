-- AlterTable: add authSource column to McpToolExecution
ALTER TABLE "McpToolExecution" ADD COLUMN IF NOT EXISTS "authSource" TEXT;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "McpToolExecution_authSource_createdAt_idx" ON "McpToolExecution"("authSource", "createdAt");

-- CreateTable: OAuthCode (used by MCP Hub OAuth server flow)
CREATE TABLE IF NOT EXISTS "OAuthCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "clientId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "OAuthCode_codeHash_key" ON "OAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "OAuthCode_expiresAt_idx" ON "OAuthCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "OAuthCode" ADD CONSTRAINT "OAuthCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
