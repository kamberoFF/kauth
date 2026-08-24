-- Changing a Project's password floor is an auth-relevant transition, so it
-- gets its own auditable SecurityEventType.
ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'PROJECT_PASSWORD_POLICY_CHANGED';
