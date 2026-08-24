-- The DB-backed CSRF token table was dead schema: CSRF has been stateless
-- signed double-submit since 2026-07 and nothing ever wrote to this table.
-- Dropped deliberately (tracker-hygiene ticket 01), not as part of any other
-- migration, so existing deployments can see the intent in their history.
DROP TABLE "csrf_tokens";
