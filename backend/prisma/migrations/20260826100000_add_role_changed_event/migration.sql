-- Changing a user's role is an auth-relevant transition (rbac ticket 02), so
-- it gets its own auditable SecurityEventType.
ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'ROLE_CHANGED';
