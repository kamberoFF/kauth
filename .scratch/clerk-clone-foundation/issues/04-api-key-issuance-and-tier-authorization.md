# 04 — API key issuance & tier-authorized access

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** A developer, once logged in (ticket 03), can generate a
publishable key and a secret key for a project they own. Requests
authenticated with a publishable key can only reach signup/login-initiation
operations; requests authenticated with a secret key additionally reach
elevated operations (verify a session, list a project's users, revoke a
session) — and neither key tier can reach project-management actions, which
stay session-only.

**Blocked by:** 03

**Status:** ready-for-agent

- [ ] A logged-in project owner can generate a publishable key and a secret
      key for their project
- [ ] The secret key's raw value is returned exactly once, at creation, and
      is never retrievable again afterward
- [ ] The publishable key remains retrievable in full at any time
- [ ] A listing of a project's keys shows a truncated prefix per key, never
      the full secret
- [ ] A request bearing a publishable key can successfully initiate
      signup/login but is rejected from elevated operations (verify
      session, list users, revoke session)
- [ ] A request bearing a secret key succeeds at the elevated operations
      above
- [ ] A request bearing either key tier is rejected from project-management
      actions (rename project, rotate/revoke another key, delete project) —
      those succeed only via an authenticated developer session
- [ ] Revoking a key immediately rejects further requests bearing it, while
      the key's own row and audit history remain queryable, never deleted
- [ ] Key issuance and revocation each produce an audit event, following
      the existing severity-by-event-type convention
- [ ] Integration tests cover both key tiers' allowed and rejected
      operations explicitly, including the boundary cases (publishable key
      attempting elevated ops, secret key attempting project-management
      ops)
