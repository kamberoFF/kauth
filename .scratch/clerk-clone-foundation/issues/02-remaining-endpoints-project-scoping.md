# 02 — Remaining endpoints made project-aware

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** Password reset, email verification, OAuth
login/callback, and account self-service (session listing/revocation,
linked-provider listing/unlinking) all correctly respect project scoping,
extending the pattern ticket 01 established to the rest of the existing auth
surface.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] Password reset only affects the account within its own project, never
      a same-email account in another project
- [ ] Email verification is scoped the same way
- [ ] OAuth login/callback links a provider account to the correct
      project's user, and a provider identity used in one project doesn't
      collide with its use in another
- [ ] Session listing/revocation only ever shows/affects sessions within
      the caller's own project
- [ ] Linked-provider listing/unlinking is similarly project-scoped
- [ ] Every affected existing integration test is updated and passing
