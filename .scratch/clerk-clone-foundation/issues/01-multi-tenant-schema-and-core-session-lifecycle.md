# 01 — Multi-tenant schema & core session lifecycle

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** The `Project` entity and project-scoped isolation across
the core auth path — register, log in, refresh, log out — so two different
projects can each register a user with the same email, completely
independently, with no cross-project leakage anywhere in the session
lifecycle.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] A `Project` entity exists and can be created (directly, for test/seed
      purposes at this stage — no dev-facing creation flow yet, that's
      ticket 03)
- [ ] The same email address can register successfully as a separate
      account in two different projects
- [ ] Login only succeeds against the project the account belongs to
- [ ] An access token issued for one project is rejected when presented
      against another project's session
- [ ] A refresh token rotates and revokes correctly within its own project,
      unaffected by identical operations happening in another project
- [ ] Logging out fully invalidates the session within its project,
      verified against `requireAuth`
- [ ] Per-account rate limiting is scoped per project — hitting the limit in
      one project doesn't throttle the same email in another
- [ ] Every existing single-tenant integration test still passes, updated
      to run within an explicit project rather than an implicit global one
