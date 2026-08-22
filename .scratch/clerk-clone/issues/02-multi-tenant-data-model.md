Type: grilling
Status: resolved

## Question

How do tenants (developer-registered projects/apps) relate to users,
sessions, accounts, and API keys in the schema? Given a greenfield redesign
with no backward-compat constraint, what's the isolation boundary — a
`tenant_id`/`project_id` column on shared tables, per-project schemas, or
something else — and how does it interact with kauth's existing
session/refresh-token-rotation/security-event model (`backend/prisma/schema`,
`lib/sessions`, `lib/securityEvents`)?

## Answer

**Isolation boundary: shared tables, tagged by a `project_id` column** — not
schema-per-project or database-per-project. With `project_id` in every
index, Postgres performance doesn't degrade with tenant count (row count
matters, not tenant count); schema/DB-per-tenant would turn every signup into
a slow, failure-prone provisioning step and every migration into a loop over
every tenant — wrong shape for a platform anyone can sign up to. This is what
Stripe/Firebase/Supabase/Clerk itself all run underneath.

**Naming: "Project"** — matches Stripe/Firebase/Supabase/Vercel, and avoids
colliding with "Organization" (Clerk's term for a later, different feature:
grouping *a project's own end-users* into teams — not this boundary).

**Email/account scope: per-project, not platform-wide.** The same email
address can hold independent, unrelated accounts in two different
projects — matches "isolated user pools" from the map's destination.

### Schema design

**New model `Project`** — the tenant boundary. `id`, `name`, `created_at`,
`updated_at`, `trusted_origins String[]` (CORS/CSRF allowlist becomes
per-project, not `config.trusted_origins` global), `owner_id` (FK to a
developer/operator account — *how that account works is ticket 03's
question*, not decided here).

**Existing models gain `project_id`**, FK'd to `Project`, indexed:
- `User`: `email @unique` → `@@unique([project_id, email])`; same for
  `username`. `Role` needs no change — already per-`User`-row, and `User`
  rows are now inherently per-project.
- `Account`: `project_id` denormalized from `User` at creation (Prisma can't
  express a composite unique through a relation). `@@unique([provider_id,
  account_id])` → `@@unique([project_id, provider_id, account_id])` — an
  OAuth account would otherwise only ever link into one project,
  platform-wide.
- `Session`: `project_id` denormalized from `User`. This is what makes the
  JWT `projectId` check in `requireAuth` free — already in the same `select`
  as `user_id`/`status`/`expires_at`, no extra join on the hottest path in
  the system.
- `RefreshToken`, `RecoveryToken`: `project_id` added for consistency with
  the existing denormalization pattern (both already carry `user_id`/
  `session_id` directly) — not required by any check, just matches the
  codebase's idiom.
- `SecurityEvent`: `project_id` sourced from **request context**, not
  derived from `user_id` — `user_id` is nullable here (e.g. failed login for
  an unknown email still needs `project_id`).
- `CsrfToken`: untouched — already dead schema per `CLAUDE.md`.

**JWT / `requireAuth`**: access-token payload gains a `projectId` claim
(`{ userId, familyId, sid, projectId, jti }`); `verifyAccessToken` rejects
tokens missing it, same as the existing strict `sid` check.
`requireAuth`'s session `select` adds `project_id`; add
`session.project_id !== payload.projectId → 401` right alongside the
existing `user_id` check — same pattern, zero extra queries. **Signing key
stays one shared platform secret** — per-project keys can be layered in
later without breaking this.

**Rate limiting**: `byAccount`'s key changes from `account:${email}` to
`account:${projectId}:${email}` — without this, two projects' identical
email addresses collide into the same rate-limit bucket.

### Explicitly deferred, not decided here

- **OAuth credentials per project** (bring-your-own Google/GitHub app vs. a
  shared kauth-branded broker) — added as a new fog item.
- **Project deletion/offboarding semantics** — `User.project_id`'s
  `onDelete` behavior isn't decided here; recommending `Restrict` as a safe
  placeholder (cascading straight to hard-delete cuts against the
  codebase's "revoke, never delete" audit philosophy) until the existing
  "data export/deletion and tenant offboarding" fog item resolves it.
- **Request → project resolution mechanism** (subdomain, API key, path
  prefix) — ticket 04's job.

No code or schema files were modified — this records the design; a future
implementation ticket applies it to `backend/prisma/schema.prisma`.
