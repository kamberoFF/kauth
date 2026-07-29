-- AlterEnum
ALTER TYPE "SecurityEventType" ADD VALUE 'USER_REGISTERED';
ALTER TYPE "SecurityEventType" ADD VALUE 'OAUTH_LOGIN_SUCCESS';
ALTER TYPE "SecurityEventType" ADD VALUE 'OAUTH_LOGIN_FAILED';
ALTER TYPE "SecurityEventType" ADD VALUE 'OAUTH_ACCOUNT_LINKED';
ALTER TYPE "SecurityEventType" ADD VALUE 'CSRF_VALIDATION_FAILED';

-- DropIndex
-- Both columns already carry unique indexes, so the composite was never usable.
DROP INDEX "users_email_username_idx";

-- CreateTable
CREATE TABLE "accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "account_id" TEXT NOT NULL,
    "password" TEXT,
    "access_token" TEXT,
    "refresh_token" TEXT,
    "id_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounts_user_id_idx" ON "accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_id_account_id_key" ON "accounts"("provider_id", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_user_id_provider_id_key" ON "accounts"("user_id", "provider_id");

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: every existing password becomes a credential account. This must run
-- before users.password is dropped or the hashes are lost.
INSERT INTO "accounts" ("id", "user_id", "provider_id", "account_id", "password", "created_at", "updated_at")
SELECT gen_random_uuid(), "id", 'credential', "id"::text, "password", "created_at", CURRENT_TIMESTAMP
FROM "users"
WHERE "password" IS NOT NULL;

-- AlterTable
ALTER TABLE "users" DROP COLUMN "password",
ADD COLUMN     "email_verified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "image" TEXT,
ALTER COLUMN "username" DROP NOT NULL;
