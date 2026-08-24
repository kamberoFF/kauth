-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_ENROLLMENT_STARTED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_ENROLLED';
ALTER TYPE "SecurityEventType" ADD VALUE 'MFA_DISABLED';
ALTER TYPE "SecurityEventType" ADD VALUE 'BACKUP_CODE_USED';
ALTER TYPE "SecurityEventType" ADD VALUE 'PROJECT_MFA_POLICY_CHANGED';

-- AlterEnum
ALTER TYPE "TokenType" ADD VALUE 'MFA_CHALLENGE';

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "enforce_mfa" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "mfa_grace_days" INTEGER;

-- AlterTable
ALTER TABLE "recovery_tokens" ADD COLUMN     "device_id" UUID;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "last_totp_step" INTEGER,
ADD COLUMN     "mfa_enrolled_at" TIMESTAMP(3),
ADD COLUMN     "mfa_grace_ends_at" TIMESTAMP(3),
ADD COLUMN     "totp_secret" TEXT;

-- CreateTable
CREATE TABLE "mfa_backup_codes" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_backup_codes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mfa_backup_codes_code_hash_key" ON "mfa_backup_codes"("code_hash");

-- CreateIndex
CREATE INDEX "mfa_backup_codes_user_id_idx" ON "mfa_backup_codes"("user_id");

-- AddForeignKey
ALTER TABLE "mfa_backup_codes" ADD CONSTRAINT "mfa_backup_codes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
