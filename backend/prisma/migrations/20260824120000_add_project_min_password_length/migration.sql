-- Per-project minimum password length. NULL falls back to the
-- deployment-wide PASSWORD_MIN_LENGTH default; resolved by lib/passwords.ts.
ALTER TABLE "projects" ADD COLUMN "min_password_length" INTEGER;
