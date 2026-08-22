Status: ready-for-agent

# kauth Platform: Self-Hosted Multi-Tenant Auth (Foundation)

Collapsed from the wayfinder map at `.scratch/clerk-clone/map.md` — that map
and its five resolved tickets (`issues/01`–`05`) remain the primary source
for the reasoning behind each decision below; this spec is the buildable
synthesis, not a replacement for it.

## Problem Statement

Developers building a product need signup, login, session management, and
OAuth — solved problems they shouldn't have to rebuild, but reaching for a
hosted vendor (Clerk, WorkOS) means their users' identity data lives on
someone else's infrastructure. kauth already solves the auth problem well
for a single first-party app; it doesn't yet let one self-hosted instance
serve many separate developers' separate products at once.

## Solution

kauth becomes a self-hosted, self-serve, multi-tenant auth platform.
Developers sign up for the platform (using kauth's own auth stack — no
second system), create a Project, and receive API keys they use to embed a
kauth SDK in their own product. Each Project's end users are completely
isolated from every other Project's — separate accounts, separate sessions,
separate audit trail — all served by the same running instance.

## User Stories

1. As a developer, I want to sign up for the kauth platform using the same auth flow any kauth-backed product uses, so that I don't need a separate account system to manage my own projects.
2. As a developer, I want to log in to the platform, so that I can access my projects.
3. As a developer, I want to create a new Project, so that I can start adding auth to a new product.
4. As a developer, I want each Project's users completely isolated from every other Project's, so that my product's user data never leaks into or collides with another developer's.
5. As a developer, I want a publishable key for my Project, so that I can safely embed it in frontend/mobile code.
6. As a developer, I want a secret key for my Project, so that my backend can perform privileged operations on my own Project's user data.
7. As a developer, I want my secret key shown to me only once at creation, so that the platform never needs to store it in a retrievable form.
8. As a developer, I want a truncated prefix of each key visible in a listing, so that I can tell which key is which without the secret being re-exposed.
9. As a developer, I want to revoke a key without losing its audit history, so that I can respond to a leak without erasing the record of what that key did.
10. As a developer, I want project-management actions (renaming my project, rotating my own keys, billing/team) to require my own login rather than just an API key, so that a leaked SDK key can't be used to take over my project.
11. As a platform operator, I want ordinary developer accounts distinguishable from platform-staff accounts, so that elevated platform-wide access stays limited to my own team.
12. As an end user of a product built on kauth, I want to sign up with email/password or Google/GitHub OAuth, exactly as kauth already supports.
13. As an end user, I want my account in one Project to be unrelated to any account I hold in another Project, even with the same email, so my identity isn't linked across products without consent.
14. As an end user, I want my session revocable by the product I'm using, so logging out fully invalidates my access rather than leaving a token valid for its full remaining lifetime.
15. As an end user, I want the login screen I see to only ever handle a publishable key, so no credential capable of reaching my private data is exposed to my browser.
16. As a downstream app's backend, I want to verify an end user's session using my secret key, so I can trust the identity behind requests hitting my own server.
17. As a downstream app's backend, I want to list my Project's own users, so I can build my own admin tooling on top of the platform's data.
18. As a downstream app's backend, I want to revoke any of my Project's users' sessions programmatically, so I can build features like "sign this user out everywhere."
19. As a downstream app's backend, I want my secret key rejected if used for project-management actions, so a compromised key can't escalate to controlling the whole project.
20. As a developer integrating kauth, I want headless functions (sign up, sign in, sign out), so I can wire the platform into UI I've already built.
21. As a developer using React, I want a reactive session hook, so my components can know the current end user's auth state.
22. As a developer, I want SDK errors to expose the same stable code/message shape the platform's API already returns, so I can branch UI logic on codes, not parsed prose.
23. As a developer, I want the backend SDK package clearly separated from the client package, so I can never accidentally bundle my secret key into client-side JavaScript.
24. As a developer, I want backend session verification to reflect real-time revocation, so my server-side checks are never stale for longer than the platform's access-token lifetime allows.
25. As a platform operator, I want the existing hardening backlog completed before this ships to real multi-tenant traffic, so the foundation is solid before it serves multiple customers' data.
26. As a platform operator, I want every auth-relevant transition — including key issuance and revocation — to still produce an audit record, so the audit trail stays complete under the new model.
27. As a platform operator, I want rate limiting scoped per project, so one project's traffic or abuse can't degrade another project's users' experience.
28. As a platform operator, I want a request's claimed project checked against its session's actual project on every authenticated request, so a token minted for one project can never reach another project's session.
29. As a developer, I want to configure my Project's allowed origins, so only my own frontend can make credentialed requests against my auth endpoints.
30. As a developer, I want deleting my Project blocked while it still has users, so I don't destroy end-user data without an explicit, separate offboarding step.

## Implementation Decisions

- New `Project` entity — the tenant boundary: name, an allowed-origins list (per-project CORS/CSRF, replacing today's single global list), and an ownership reference to a developer account.
- Existing entities (users, sessions, linked OAuth accounts, refresh tokens, recovery tokens, security-audit events) each gain a project-scoping reference. Uniqueness that's global today (email, username, linked-account identity) becomes scoped per project instead — the same email may hold independent accounts in two different projects.
- One reserved, platform-owned Project is seeded at deploy time; the platform's own developer/operator accounts are ordinary user rows inside it — dogfooding the existing auth stack rather than building a second one. An existing role distinction already on the user record separates ordinary developers from platform staff; no new field needed.
- Access tokens carry a project identifier as a claim; session validation checks it against the session's actual project, the same shape as the existing user-identity check — no additional database round trip.
- The token-signing key remains one shared platform-wide secret this phase. Per-project signing keys, and the already-separately-planned move to asymmetric/rotatable signing, are explicitly not part of this decision.
- Account-scoped rate-limit keys incorporate the project identifier, so identical email addresses in different projects can no longer share a throttle bucket.
- New `ApiKey` entity with two tiers of materially different authority:
  - **Publishable** — safe for a browser/mobile bundle; can only initiate signup/login for that project's end users; stored and remains retrievable in full.
  - **Secret** — backend-only; additionally grants elevated access to that project's own end-user data (session verification, user listing, session revocation); stored only as an irreversible hash, shown once at creation, never retrievable again.
  - Neither tier reaches project-management actions (rename, key rotation, deletion, billing/team) — those require an authenticated developer session, unreachable by any key.
- API-key-authenticated requests use a distinct authentication path from session-based requests — a key resolves to a project, not to a user identity — running alongside the existing session-validation path rather than replacing or merging with it.
- New audit-event types cover key issuance and revocation, following the existing convention where an event's severity is derived from its type rather than passed per call site.
- Project deletion is blocked while the project still has users attached — a deliberately conservative placeholder pending a separate decision on full tenant-offboarding semantics.
- SDK ships as two separate packages that are never combined into one distribution artifact: a client package (browser/mobile-safe, publishable-key-scoped: sign up, sign in, sign out, a reactive session hook for the first supported framework) and a backend package (server-only, secret-key-scoped: session verification, user listing, session revocation — each a network call back to the platform, since the signing key isn't available to project backends for local verification).
- Both SDK packages surface the platform's existing structured error shape (a stable code alongside a human-readable message) directly, rather than wrapping it in a generic error type.
- No prebuilt UI components in this phase — the SDK ships headless; a themeable component layer is an explicit later decision.

## Testing Decisions

- One seam for the entire spec: a real HTTP request against a running
  instance of the server, backed by a real database — the same seam the
  existing integration suite already uses (server startup, database reset
  before each test, and a shared request helper). No new seam is introduced
  for any of the four build areas, SDK included — SDK tests point the SDK's
  own HTTP client at the same running test server rather than mocking the
  transport layer.
- Tests assert on behavior visible at that seam — response status, body,
  error code, and resulting database state — never on internal function
  calls.
- Multi-tenancy is tested by exercising the same endpoints under two or more
  distinct projects and asserting isolation directly: identical email
  addresses succeeding independently in each, one project's data never
  surfacing in another project's responses, one project's rate limiting
  never throttling another's traffic.
- The dev-auth bootstrap is tested through the same register/login endpoints
  scoped to the reserved platform project, not a separate test path —
  proving the "dogfooding, not a second stack" decision actually holds.
- API-key authentication is tested by issuing requests under each key tier
  and asserting both what succeeds and what's correctly rejected — a
  publishable key attempting a secret-tier operation, a secret key
  attempting a project-management action, both must fail.
- Any test guarding an isolation boundary (project scoping, key-tier
  authority) gets mutation-checked — broken deliberately once to confirm it
  actually fails without the guard in place, matching this codebase's
  existing convention for security-property tests.
- Prior art: the existing integration suite already follows exactly this
  pattern for today's single-tenant flows (registration, login, refresh
  rotation, revocation) — this spec extends those suites and idioms rather
  than introducing a parallel testing convention.

## Out of Scope

- Dashboard UI/UX for developers managing projects, keys, and users
- Billing/usage metering and plan limits
- Webhooks for downstream apps to react to auth events
- Per-tenant branding/custom domains for hosted auth pages
- A documentation site for third-party developers
- Platform-level abuse-prevention beyond the immediate per-project
  rate-limit key fix
- Full tenant/project offboarding semantics beyond the
  deletion-blocked-while-populated placeholder
- OAuth credentials configurable per project (bring-your-own vs. a shared
  broker)
- Team/multi-developer ownership of a single project
- Test/live (sandboxed) environment modes
- Prebuilt, themeable SDK UI components
- SDK bindings for frameworks beyond the first one
- Enterprise SSO federation (SAML/SCIM) — a different product posture than
  the one this platform targets
- Any change to the existing hardening backlog's priority order — it still
  precedes this work shipping to real multi-tenant traffic

## Further Notes

- The out-of-scope fog above is expected to generate its own follow-up
  specs/tickets once each item is sharp enough to charter — it's sequenced
  after this foundation, not abandoned.
- `docs/roadmap.md`'s current statement that the platform is "not an
  identity provider other applications integrate against" is superseded by
  this spec's destination and should be revised once this work begins
  landing, not before.
- Testing seam confirmed directly with the user before this spec was
  written: one seam (real HTTP against real Postgres) for all four build
  areas, SDK included — no mocked-transport alternative for the SDK.
- **Tickets published**: six tracer-bullet implementation tickets at
  `.scratch/clerk-clone-foundation/issues/01`–`06`, blockers-first
  (01 → {02, 03} → 04 → {05, 06}).
