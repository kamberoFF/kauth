# 02 — Remaining endpoints made project-aware

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** Password reset, email verification, OAuth
login/callback, and account self-service (session listing/revocation,
linked-provider listing/unlinking) all correctly respect project scoping,
extending the pattern ticket 01 established to the rest of the existing auth
surface.

**Blocked by:** 01

**Status:** done

- [x] Password reset only affects the account within its own project, never
      a same-email account in another project
- [x] Email verification is scoped the same way
- [x] OAuth login/callback links a provider account to the correct
      project's user, and a provider identity used in one project doesn't
      collide with its use in another
- [x] Session listing/revocation only ever shows/affects sessions within
      the caller's own project
- [x] Linked-provider listing/unlinking is similarly project-scoped
- [x] Every affected existing integration test is updated and passing

## Comments

- 2026-08-22: Marking done to match what's merged on `main` (`33a2385`,
  `95dd558`, `d62c3f6`) — `backend/tests/account.test.ts` and the sessions
  suite were extended alongside the controllers.
- 2026-08-22 (later, starting ticket 03): confirmed with Docker Desktop
  running — `bun test` is 130 pass / 0 fail against a live Postgres, prior
  to ticket 03's own suite being added on top.
