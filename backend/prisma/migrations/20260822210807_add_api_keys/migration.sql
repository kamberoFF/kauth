-- CreateEnum
CREATE TYPE "ApiKeyType" AS ENUM ('PUBLISHABLE', 'SECRET');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SecurityEventType" ADD VALUE 'API_KEY_ISSUED';
ALTER TYPE "SecurityEventType" ADD VALUE 'API_KEY_REVOKED';

-- CreateTable
CREATE TABLE "api_keys" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "key_type" "ApiKeyType" NOT NULL,
    "key_prefix" TEXT NOT NULL,
    "key_value" TEXT,
    "key_hash" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "api_keys_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_prefix_key" ON "api_keys"("key_prefix");

-- CreateIndex
CREATE UNIQUE INDEX "api_keys_key_value_key" ON "api_keys"("key_value");

-- CreateIndex
CREATE INDEX "api_keys_project_id_idx" ON "api_keys"("project_id");

-- CreateIndex
CREATE INDEX "api_keys_created_by_user_id_idx" ON "api_keys"("created_by_user_id");

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
