-- A Project owner changed a Provider app (per-project OAuth credentials,
-- ADR 0009): configured an override, disabled a provider, or cleared a row
-- back to inheriting the instance app. Kept in its own migration so the
-- ADD VALUE runs in a transaction that never also uses the new label.
ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'PROJECT_OAUTH_CONFIG_CHANGED';
