> **Spec published**: [`spec.md`](spec.md) collapses tickets 01–05 into one
> buildable spec (`ready-for-agent`). **Implementation tickets published**:
> six tracer-bullet tickets at `../clerk-clone-foundation/issues/01`–`06`,
> ready for `/implement`.

## Destination

A phased product spec for kauth as a self-hosted, self-serve, multi-tenant
auth platform (a Clerk/WorkOS-style clone): outside developers sign up,
register their own apps/projects, get API keys, and wire up a kauth SDK to
add signup/login/session management to their product — all backed by one
shared, self-hosted kauth instance with per-tenant-isolated user pools. The
spec enumerates the full feature surface (tenancy model, API keys, dashboard,
SDK, billing/limits, webhooks, per-tenant branding) and a build order, ready
to hand off for execution.

## Notes

- kauth's existing single-tenant auth backend (`backend/`, see root
  `CLAUDE.md`) is the foundation being extended, not replaced.
- The hardening backlog in `docs/roadmap.md` (Operations → Argon2id →
  identity-oracle fixes → session policy → multi-instance readiness) precedes
  this work — standing constraint, not open for re-litigation on this map.
  Multi-instance readiness is a hard prerequisite for a real hosted platform.
- This map's destination reverses `docs/roadmap.md`'s current "Deliberately
  not doing: becoming an OIDC provider... not an identity provider other
  applications integrate against" line. That line gets struck/rewritten once
  this map's spec lands — not before.
- Greenfield: no existing deployment/data constrains schema redesign.
- SSO posture is Clerk-style (kauth is the IdP a product embeds via SDK), not
  WorkOS-style enterprise SAML/SCIM federation — see Out of scope.
- `.scratch/library-pivot/spec.md` (exploratory, uncommitted) is still
  relevant as this platform's SDK/client layer, not a competing direction —
  see the ticket reconciling it.
- Invoke `/grilling` and `/domain-modeling` for each ticket, per default
  wayfinder practice. No `CONTEXT.md` or `docs/adr/` exist yet at repo root;
  domain-modeling will create them lazily as this map's vocabulary
  (tenant/project, API key, SDK) gets pinned down.

## Decisions so far

- [Reconcile the library-pivot spec with the platform direction](issues/01-reconcile-library-pivot-spec.md) — edited `.scratch/library-pivot/spec.md` in place: marked superseded, added a "What changed" section, annotated which original claims still hold (hardening-first sequencing, greenfield) vs. which the platform direction overrides (embed-in-process repo split, self-service as library functions). SDK's actual shape left to ticket 05.
- [Multi-tenant data model](issues/02-multi-tenant-data-model.md) — shared tables tagged by a `project_id` column (not schema/DB-per-tenant); the tenant entity is named "Project"; email/accounts are isolated per-project; `Session`/JWT gain a `projectId` claim checked in `requireAuth` alongside the existing `userId` check, no extra query; signing key stays one shared platform secret. Full field-by-field design (new `Project` model, `project_id` added to `User`/`Account`/`Session`/`RefreshToken`/`RecoveryToken`/`SecurityEvent`, updated unique constraints, rate-limit key fix) is in the ticket.
- [Developer-facing auth bootstrap](issues/03-developer-facing-auth-bootstrap.md) — kauth dogfoods itself: developers/operators are `User` rows in one reserved platform-owned `Project`, reusing the same session/refresh/audit machinery rather than a second auth stack. `Role` already distinguishes ordinary developers from platform staff, no new field needed.
- [API key & credential model](issues/04-api-key-credential-model.md) — three authority tiers, not two: publishable key (frontend-safe, can only start signup/login), secret key (backend-only, elevated access to that project's own end-user data — Supabase anon/service_role framing), developer session (governs the project itself as a resource — rename/rotate-keys/billing, unreachable by any key). New `ApiKey` model, revoked-not-deleted. API-key auth is a parallel request path alongside session-based `requireAuth`, not a variant of it.
- [SDK/client library shape](issues/05-sdk-client-library-shape.md) — headless first (functions + a `useSession()` hook, no prebuilt UI), TypeScript/JS core + React bindings. Two packages, not one, forced by ticket 04's key tiers: a client package (publishable key) and a backend package (secret key) that must never share a bundle. Backend session verification is a real network round-trip, not a local JWT decode — forced by ticket 02's shared signing secret. Both pass through kauth's existing `{ error: { message, code } }` contract untouched.

## Not yet specified

- OAuth credentials per project — bring-your-own Google/GitHub app vs. a
  shared kauth-branded broker (surfaced while resolving ticket 02; related to
  but distinct from ticket 04's SDK-authentication question)
- Team/multi-developer ownership of one Project (co-managed projects, the way
  Vercel/Stripe team seats work) — surfaced while resolving ticket 03
- Test/live mode (sandboxed environments per project, Clerk/Stripe-style) —
  surfaced while resolving ticket 04, deliberately parked rather than designed
- Prebuilt/themeable SDK UI components (drop-in `<SignIn/>`-style forms) —
  surfaced while resolving ticket 05, deferred in favor of headless-first
- SDK framework bindings beyond React (Vue, Next.js middleware, Express
  middleware for the backend package) — surfaced while resolving ticket 05
- Dashboard UI/UX for developers managing projects, API keys, users
  (`frontend/` is an unstyled Vite+React scaffold today, no auth client)
- Billing/usage metering and plan limits for the self-serve platform
- Webhooks for downstream apps to react to auth events (user.created,
  session.revoked, etc.)
- Per-tenant branding/custom domains for hosted auth pages
- Docs site for third-party developers
- Platform-level rate limiting/abuse prevention (distinct from the existing
  per-IP/per-account limits, which are per-tenant-app today)
- Data export/deletion and tenant offboarding
- Pricing/licensing model (self-hosted open source vs. hosted paid tiers —
  undiscussed)

## Out of scope

- Enterprise SSO federation (SAML/OIDC-as-relying-party to a customer's own
  IdP) and SCIM directory sync — the WorkOS posture. Ruled out in favor of the
  Clerk-style SDK-embed posture during chartering. Could become a fresh
  destination/map later if enterprise demand appears — not a resumption of
  this one.
