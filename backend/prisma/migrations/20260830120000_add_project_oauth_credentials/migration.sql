-- Per-Project OAuth Provider apps (ADR 0009): a Project may bring its own
-- client_id / client_secret for a built-in provider (OVERRIDE) or suppress a
-- provider entirely (DISABLED). No row means the Project inherits the instance
-- env credentials. The secret is stored as lib/cryptoBox.ts ciphertext, never
-- plaintext.

-- CreateEnum
CREATE TYPE "OAuthCredentialMode" AS ENUM ('OVERRIDE', 'DISABLED');

-- CreateTable
CREATE TABLE "project_oauth_credentials" (
    "id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "provider_id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret_enc" TEXT,
    "mode" "OAuthCredentialMode" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "project_oauth_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "project_oauth_credentials_project_id_idx" ON "project_oauth_credentials"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "project_oauth_credentials_project_id_provider_id_key" ON "project_oauth_credentials"("project_id", "provider_id");

-- AddForeignKey
ALTER TABLE "project_oauth_credentials" ADD CONSTRAINT "project_oauth_credentials_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
