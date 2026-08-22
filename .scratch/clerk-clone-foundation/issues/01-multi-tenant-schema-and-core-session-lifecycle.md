# 01 — Multi-tenant schema & core session lifecycle

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** The `Project` entity and project-scoped isolation across
the core auth path — register, log in, refresh, log out — so two different
projects can each register a user with the same email, completely
independently, with no cross-project leakage anywhere in the session
lifecycle.

**Blocked by:** None — can start immediately

**Status:** done

- [x] A `Project` entity exists and can be created (directly, for test/seed
      purposes at this stage — no dev-facing creation flow yet, that's
      ticket 03)
- [x] The same email address can register successfully as a separate
      account in two different projects
- [x] Login only succeeds against the project the account belongs to
- [x] An access token issued for one project is rejected when presented
      against another project's session
- [x] A refresh token rotates and revokes correctly within its own project,
      unaffected by identical operations happening in another project
- [x] Logging out fully invalidates the session within its project,
      verified against `requireAuth`
- [x] Per-account rate limiting is scoped per project — hitting the limit in
      one project doesn't throttle the same email in another
- [x] Every existing single-tenant integration test still passes, updated
      to run within an explicit project rather than an implicit global one

## Answer

Landed on branch `ticket-01-multi-tenant-schema` across 5 commits (schema +
migration; core plumbing; controllers/auth.ts + isolation tests; OAuth/
account/seed collateral; remaining test suites). Full detail in
`C:\Users\kambe\.claude\plans\enchanted-greeting-donut.md` (the approved
implementation plan) and the commit messages themselves.

Key design point not fully settled by the wayfinder decision ticket: request
project resolution split three ways depending on whether the endpoint has a
prior project-scoped record to derive from — an `X-Project-Id` header
(register/login/send-verification-email/forgot-password), derived
server-side from the loaded session/token row (refresh/logout/verify-email/
reset-password/change-password), or a `?projectId=` query param riding the
existing OAuth state-cookie round trip (startOAuth/oauthCallback).

`bun test`: 103 pass, 0 fail. `bun run typecheck` and `bun run lint`: clean.
Mutation-checked the `requireAuth` project check, login's project-scoped
lookup, and the `byAccount` rate-limit key by hand — all three isolation
properties fail without their guard.

Unblocks 02 (remaining endpoints project-scoping) and 03 (developer-facing
auth bootstrap).
