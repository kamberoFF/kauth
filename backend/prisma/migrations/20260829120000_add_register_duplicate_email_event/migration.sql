-- A register attempt on an already-registered email is an auth-relevant
-- transition (register-oracle ticket 01 / ADR 0008): the HTTP response is
-- deliberately indistinguishable from a fresh signup, so this server-side-only
-- event is the only place a repeat attempt on a known address stays visible.
ALTER TYPE "SecurityEventType" ADD VALUE IF NOT EXISTS 'REGISTER_DUPLICATE_EMAIL';
