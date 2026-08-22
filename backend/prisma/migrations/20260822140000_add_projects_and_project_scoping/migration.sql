-- DropIndex
DROP INDEX "accounts_provider_id_account_id_key";

-- DropIndex
DROP INDEX "users_email_key";

-- DropIndex
DROP INDEX "users_username_key";

-- AlterTable
ALTER TABLE "accounts" ADD COLUMN     "project_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "recovery_tokens" ADD COLUMN     "project_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "refresh_tokens" ADD COLUMN     "project_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "security_events" ADD COLUMN     "project_id" UUID;

-- AlterTable
ALTER TABLE "sessions" ADD COLUMN     "project_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "project_id" UUID NOT NULL;

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trusted_origins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "owner_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "projects_owner_id_idx" ON "projects"("owner_id");

-- CreateIndex
CREATE INDEX "accounts_project_id_idx" ON "accounts"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_project_id_provider_id_account_id_key" ON "accounts"("project_id", "provider_id", "account_id");

-- CreateIndex
CREATE INDEX "recovery_tokens_project_id_idx" ON "recovery_tokens"("project_id");

-- CreateIndex
CREATE INDEX "refresh_tokens_project_id_idx" ON "refresh_tokens"("project_id");

-- CreateIndex
CREATE INDEX "security_events_project_id_idx" ON "security_events"("project_id");

-- CreateIndex
CREATE INDEX "sessions_project_id_idx" ON "sessions"("project_id");

-- CreateIndex
CREATE INDEX "users_project_id_idx" ON "users"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_project_id_email_key" ON "users"("project_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "users_project_id_username_key" ON "users"("project_id", "username");

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_tokens" ADD CONSTRAINT "recovery_tokens_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

