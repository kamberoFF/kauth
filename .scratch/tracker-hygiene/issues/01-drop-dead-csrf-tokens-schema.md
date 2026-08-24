# 01 — Drop the dead `csrf_tokens` schema

**Blocked by:** None - can start immediately
**Status:** done

## What to build

CSRF has been stateless signed double-submit since the 2026-07 remediation;
the DB-backed `csrf_tokens` table has never been written to by any code path.
CLAUDE.md records it as "dead schema ... should be dropped, but has not been
touched unilaterally." The user has now explicitly decided to drop it, so
this ticket does that deliberately:

- Remove the `CsrfToken` model from `backend/prisma/schema.prisma` and the
  `csrfTokens CsrfToken[]` relation on `Session`.
- Ship a migration that drops the `csrf_tokens` table (its indexes and the
  `session_id` foreign key go with it).
- Regenerate the Prisma client to
  `backend/generated/prisma`.
- Guard against regression with a test asserting the table no longer exists
  after migrations run.
- Update living docs that describe the table as pending deletion:
  CLAUDE.md's "looks wrong but are deliberate" entry and the roadmap's
  "Deliberately not doing" bullet. Dated audit/remediation logs are history
  and must not be edited.

**Explicitly out of scope:** the stateless CSRF middleware itself
(`middlewares/csrf.ts`, `issueCsrfToken`, the `/csrf-token` endpoint) — all
of that is live code protecting cookie transport. Only the unused storage
goes.

## Acceptance criteria

- [x] `csrf_tokens` no longer appears in `schema.prisma`; a fresh
      `prisma migrate deploy` leaves no such table in the database.
- [x] A test fails if the table (or any reference to it) is reintroduced.
- [x] `bun run typecheck`, `bun run lint`, and the full integration suite
      pass.
- [x] CLAUDE.md and `docs/roadmap.md` no longer describe the table as
      existing-but-pending-deletion.
