Status: ready-for-agent

# Project owner management surface (dir name "tenant-rbac" is historical)

Collapsed from the deferred-closeout batch's **session-2 grilling**
(`/grill-with-docs` — grilling + domain-modeling, frontier cleared over four
rounds, 2026-08-29). The settled design lives in
`.scratch/deferred-closeout/plan.md` under "Session 2 grilling outcome →
Tenant RBAC"; this spec is the buildable synthesis of the first half of
**batch epic 2**. The second half is `.scratch/project-oauth/spec.md`.

**Name note.** The routing plan and the wayfinder memory call this epic
"tenant RBAC", and its tracker directory is `.scratch/tenant-rbac/`. The
grilling outcome (round-1 Q2) settled that there is **no new role and no
end-user admin** — `Role.ADMIN` stays inert in tenant Projects exactly as
today, ADR 0007 is untouched, and there is no ADR for this half. What is
actually built is a bigger **session-authenticated management surface for the
Project owner** over their own Project. The directory keeps its name for
trail continuity; the feature is the owner surface.

**Contract.** Epic 2 bumps the contract version to **`0.7.0`** — one bump for
the whole epic. Implementation order across the batch is
`… → tenant-rbac → project-oauth → …`, so **this spec's backend ticket is
where `0.7.0` lands**; `project-oauth` does not re-bump. See "Implementation
Decisions → Contract version".

## Problem Statement

A Project owner is a developer — a `User` row in the reserved platform
Project, named on `Project.owner_id`. Today the owner governs the Project
*as a resource* through a session-authenticated surface (`POST /projects`,
`PATCH /projects/:projectId`, and the API-key routes under
`/projects/:projectId/keys`), but has almost no session-authenticated window
into what is *inside* their Project:

- **Users** — the only listing is `GET /project/users`, which requires the
  Project's **secret API key**. An owner who wants to see their own users
  from something interactive has to embed a secret key in it.
- **Sessions** — same: `GET /project/sessions/:sessionId` and its `DELETE`
  are secret-key-only, and there is **no endpoint at all** that lists a
  Project's sessions. Neither the owner nor a downstream backend can answer
  "show me every active session in this Project".
- **Audit log** — `security_events` rows are written for every auth-relevant
  transition in the Project, and **nothing exposes them**. Not to the owner,
  not to a secret key. The platform-staff surface (ADR 0007) can read events
  across all tenants, but an owner cannot read their own.

ADR 0007 built the cross-tenant platform-staff surface and explicitly
deferred "per-project tenant admins (an app's end users governing each
other)" until a consuming app named requirements. The grilling re-examined
that and chose the smaller thing: the owner — who already has a session and
already governs the Project — gets the management reads they are missing,
with no new role introduced.

## Solution

Extend the owner's existing `/projects/:projectId/*` surface (behind
`requireAuth` + `requireProjectOwnership`) with read and revoke access to the
Project's users, sessions, and security events — the same shape as the
platform-staff surface (ADR 0007), scoped to one owned Project and
authenticated by the owner's session rather than an ADMIN role:

- `GET /projects/:projectId/users`
- `GET /projects/:projectId/sessions` — **new capability**: a Project-wide
  active-session list, filterable by user
- `GET /projects/:projectId/sessions/:sessionId`
- `DELETE /projects/:projectId/sessions/:sessionId`
- `GET /projects/:projectId/events` — **new capability**: the Project's
  `security_events`, reverse-chronological, cursor-paginated, filterable by
  event type and user

The two genuinely new read capabilities — the audit-event list and the
Project-wide session list — are **also mirrored onto the secret-key
`/project/*` surface**, because a downstream backend is the more natural
consumer of both (user stories 17/18 in the foundation spec already gesture
at "build my own admin tooling" and "sign this user out everywhere"):

- `GET /project/events`
- `GET /project/sessions`

The `backend-sdk` package grows `listEvents()` and `listSessions()` to match.
Write access to Project config (settings, keys, and — from the other epic-2
spec — OAuth credentials) stays **owner-session only**; a secret key is
rejected there exactly as it is on the key routes today.

No new `SecurityEventType`, no ADR, no change to the `Role`, `Platform
staff`, or `Account` glossary entries. A roadmap note records the surface.

## User Stories

1. As a Project owner, I want to list my Project's end users from my logged-in
   developer session, so that I can build admin tooling without embedding a
   secret key in an interactive app.
2. As a Project owner, I want to see every active session in my Project, so
   that I can spot anomalies and build a "sessions" view for my support team.
3. As a Project owner, I want to filter that session list by user id, so that
   I can answer "where is this specific user signed in".
4. As a Project owner, I want to look up a single session by id, so that I can
   inspect one flagged session without pulling the whole list.
5. As a Project owner, I want to revoke any active session in my Project, so
   that I can respond to a report of a compromised account.
6. As a Project owner, I want a revoked session to leave an audit row
   attributed to me as the actor, so that the log shows who cut it and
   distinguishes my action from a staff revoke, a secret-key revoke, or the
   user's own logout.
7. As a Project owner, I want to read my Project's security-event log, so that
   I can see logins, failures, password resets, MFA changes, and key
   issuance/revocation for my own Project.
8. As a Project owner, I want the event list reverse-chronological and
   paginated, so that a busy Project's log is navigable rather than one
   enormous response.
9. As a Project owner, I want to filter events by type and by user id, so that
   I can answer "show me every failed login for this user".
10. As a Project owner, I want every one of these routes to return the same
    404 for a Project that is not mine as for one that does not exist, so that
    the surface discloses nothing about other Projects.
11. As a Project owner, I want reads scoped strictly to my Project — no event,
    session, or user from another Project ever appears — so that the tenant
    boundary holds on the management surface too.
12. As a downstream app's backend, I want to list my Project's sessions with
    my secret key, so that I can implement "sign out everywhere" and a
    sessions view in my own product.
13. As a downstream app's backend, I want to read my Project's security events
    with my secret key, so that I can stream them into my own logging or
    security tooling.
14. As a downstream app's backend, I want those two secret-key reads to be
    scoped by the key's own Project, never a client-supplied id, so that a
    leaked key cannot read another Project's log.
15. As a downstream app's backend integrating the `backend-sdk`, I want
    `listSessions()` and `listEvents()` methods with typed results and cursor
    pagination, so that I do not hand-roll the HTTP and paging.
16. As a developer, I want the `backend-sdk` version and contract-version
    constant bumped to `0.7.0` with a changelog entry, so that my coordinated
    redeploy (ADR 0003) has one version to align on.
17. As a developer integrating the `client-sdk`, I want its version bumped to
    `0.7.0` too even though the end-user auth surface did not change, so that
    all three package versions stay in lockstep the way `contractVersion.test`
    enforces.
18. As an operator, I want the owner's write routes (settings, keys, OAuth
    credentials) to keep rejecting a secret-key-only request with `401`, so
    that a leaked SDK key still cannot reconfigure the Project.
19. As a maintainer, I want no new `Role` semantics, no new enum value, and no
    ADR for this half, so that a future session does not think a tenant-admin
    role was introduced — `Role.ADMIN` in a tenant Project still gates
    nothing.
20. As a maintainer, I want the isolation boundaries (owner-of-A cannot read
    B; secret-key-of-A cannot read B's events) covered by tests that fail if
    the Project filter is dropped, so that a refactor cannot silently widen
    the surface.
21. As a maintainer, I want `docs/roadmap.md` and `CLAUDE.md`'s route
    inventory updated to describe the owner surface, so that the docs match
    what shipped.

## Implementation Decisions

### Owner management routes (session-authenticated)

Mounted alongside the existing owner routes in `routes/projects.ts` (or a new
`routes/projectManagement.ts` — implementer's call), every route behind
`requireAuth, requireProjectOwnership`. `requireProjectOwnership` already
validates the `:projectId` param, checks `owner_id === req.userId`, collapses
missing-or-not-owned into one `404 project_not_found`, and sets
`req.projectId` — reuse it unchanged.

- **`GET /projects/:projectId/users`** — same projection as
  `controllers/projectAccess.ts:listProjectUsers` and
  `controllers/admin.ts:listProjectUsers` (`id`, `email`, `username`,
  `emailVerified`, `role`, `createdAt`), ordered `created_at asc`. Reuse the
  shared user serializer rather than a third copy.
- **`GET /projects/:projectId/sessions`** — a new Project-wide session list.
  `status: "ACTIVE"` only (matching every other session list in kauth — the
  events log carries revocation history). Optional `?userId=` filter (UUID or
  `400`). Cursor-paginated (see "Pagination"). Management projection: `id`,
  `userId`, `status`, `deviceId`, `deviceName`, `deviceType`, `osName`,
  `osVersion`, `browserName`, `browserVersion`, `ipCreated`, `ipLast`,
  `countryCreated`, `countryLast`, `cityCreated`, `cityLast`, `createdAt`,
  `lastUsedAt`, `expiresAt`. No `current` flag (that is a self-service
  concept — there is no "current" session on this surface).
- **`GET /projects/:projectId/sessions/:sessionId`** — same projection as
  `controllers/admin.ts:getSession` (`id`, `userId`, `status`, `createdAt`,
  `lastUsedAt`, `expiresAt`, `revokedAt`), additionally scoped
  `project_id = req.projectId`. `400` on a malformed id, `404` on a miss or a
  cross-Project id.
- **`DELETE /projects/:projectId/sessions/:sessionId`** — revoke any `ACTIVE`
  session in the Project. `revokeSessions(tx, { id: sessionId, project_id:
  req.projectId }, "owner_revoked")`; a non-existent / already-revoked /
  cross-Project id is a clean `404` (same idiom as
  `controllers/projectAccess.ts:revokeProjectSession`). Writes
  `SESSION_REVOKED` in the same transaction (see "Actor attribution").
- **`GET /projects/:projectId/events`** — the Project's `security_events`,
  ordered `created_at desc, id desc`. Cursor-paginated. Filters: `?eventType=`
  (repeatable or comma-separated; each value validated against
  `SecurityEventType` or `400`) and `?userId=` (UUID or `400`). Projection:
  `id`, `eventType`, `severity`, `userId`, `sessionId`, `ip`, `userAgent`,
  `metadata`, `createdAt`. `metadata` is returned **as stored** — `CLAUDE.md`
  already forbids tokens / hashes / credentials in it, and the identifiers
  that do land there (`provider`, `actor_user_id`, `old_role` / `new_role`,
  `apiKeyId`) are things a Project owner is entitled to see about their own
  Project.

### Secret-key routes (parallel path)

Added to `routes/projectAccess.ts`, behind `requireSecretKey`, Project
implicit from the key (`req.projectId` set by the middleware) — flat, no
`:projectId` in the path, exactly like the existing `/project/*` routes.

- **`GET /project/sessions`** — same query, projection, filters, and paging
  as the owner session-list route.
- **`GET /project/events`** — same as the owner events route.

The existing `GET /project/users`, `GET /project/sessions/:sessionId`, and
`DELETE /project/sessions/:sessionId` are unchanged. `GET /project/sessions`
(list) and `GET /project/sessions/:sessionId` (detail) are distinct Express
routes and coexist.

### Shared query/serialize layer

The owner routes and the secret-key routes must not carry divergent copies of
the query or the projection. Extract the users-list / sessions-list /
session-detail / events-list query+serialize into a shared module (a
`lib/projectManagement.ts` or a single controller module consumed by both
route groups). The only difference between the two callers is how
`req.projectId` was resolved — `requireProjectOwnership` (owned Project) vs.
`requireSecretKey` (key's Project) — which is already the pattern
`controllers/projectAccess.ts` documents ("every query here is scoped by
`req.projectId` alone").

### Pagination

kauth has no prior cursor pagination. Add one minimal helper
(`lib/pagination.ts`), keyset-style:

- Query params: `?limit=` (default 50, clamped to 1–200) and `?cursor=`.
- The cursor is an opaque base64url string encoding the ordering key of the
  last row returned — for both lists that is `{ createdAt, id }`. Decode
  failure → `400 cursor_invalid`.
- The query adds `WHERE (created_at, id) < (cursor.createdAt, cursor.id)` (a
  real keyset predicate, not `OFFSET`), keeps `ORDER BY created_at desc, id
  desc`, and fetches `limit + 1` rows to know whether a next page exists.
- Response shape: `{ <items>: [...], nextCursor: string | null }` —
  `nextCursor` null on the last page.

Used by `events` and `sessions` on both surfaces. Nothing else adopts it in
this epic.

### Actor attribution on `SESSION_REVOKED`

Today `SESSION_REVOKED` metadata varies by caller: `{ apiKeyId }`
(secret-key path, `projectAccess.ts`), `{ actor_user_id }` (staff path,
`admin.ts`), or absent (self-service, `sessions.ts`). The owner path adds a
marker. Preferred: normalise all four call sites to a single discriminator —
`metadata.actor` one of `"self" | "owner" | "staff" | "api_key"`, plus the
relevant id (`actor_user_id` for `owner`/`staff`, `api_key_id` for
`api_key`). This is a small, mechanical cleanup and makes the events endpoint
above legible. Acceptable fallback if the cleanup is deemed out of scope:
leave the three existing shapes and add `{ actor: "owner", actor_user_id }`
for the owner path only — but then say so in the ticket.

### Contract version

- `backend/package.json` → **`0.7.0`**. `config.contract_version` reads it,
  so `X-Kauth-Contract-Version` follows.
- `packages/backend-sdk` and `packages/client-sdk`: `src/version.ts`
  `CONTRACT_VERSION` → `"0.7.0"`, `package.json` version → `0.7.0`.
  `contractVersion.test.ts` asserts the three stay in lockstep.
- **This is the single epic-2 bump.** `project-oauth`'s tickets must check
  that `0.7.0` is already in place and not bump again. If for any reason
  `project-oauth` lands first, it does the bump and this spec's ticket
  checks instead — the tickets cross-reference.
- `client-sdk` has no API change in this half; the bump is lockstep-parity
  only (ADR 0003: every upgrade is one coordinated redeploy). Changelog entry
  in both packages.

### `backend-sdk` additions

`packages/backend-sdk/src/index.ts`:

- Extend the internal `request(method, path)` to `request(method, path,
  query?)` so list methods can pass `{ limit, cursor, userId, eventType }`.
- **`listSessions(options?: ListSessionsOptions): Promise<Page<KauthSessionSummary>>`**
  → `GET /project/sessions`. `ListSessionsOptions` = `{ userId?, limit?,
  cursor? }`. `Page<T>` = `{ items: T[]; nextCursor: string | null }`.
- **`listEvents(options?: ListEventsOptions): Promise<Page<KauthSecurityEvent>>`**
  → `GET /project/events`. `ListEventsOptions` = `{ eventType?: string |
  string[]; userId?; limit?; cursor? }`.
- New exported types `KauthSessionSummary`, `KauthSecurityEvent`, `Page<T>`,
  the two options interfaces. `KauthSecurityEvent.metadata` typed as
  `Record<string, unknown> | null`.
- `verifySession` / `listUsers` / `revokeSession` unchanged. `listUsers`
  stays non-paginated (its underlying `/project/users` route is unchanged).
- Changelog entry.

### Explicitly unchanged

- `Role` enum, `requirePlatformStaff`, the `/admin/*` surface, ADR 0007.
- The self-service `/sessions` routes (`routes/sessions.ts`) and
  `controllers/sessions.ts`.
- `PATCH /projects/:projectId`, `POST /projects`, the `/projects/:projectId/keys`
  routes.
- `client-sdk` API surface (version bump only).
- `CONTEXT.md` — no change in this spec (the other epic-2 spec adds
  **Provider app**; that was done during the grilling session).

## Testing Decisions

A good test asserts **observable external behaviour**: HTTP status, response
body shape, which rows appear (and which do not), `security_events` contents,
and the `nextCursor` round trip. Not: which internal helper ran the query.

### Seams

**One, existing:** `api()` HTTP against a real test server backed by real
Postgres — the seam `adminSurface.test.ts`, `projects.test.ts`,
`auditLog.test.ts`, and `sessions.test.ts` already use. No new backend seam.

**Existing SDK seam:** `backendSdk.test.ts` — the `backend-sdk`'s own HTTP
client against the same running test server — for `listSessions()` /
`listEvents()`.

### Prior art

- `backend/tests/adminSurface.test.ts` — the staff surface's list / get /
  revoke shape, plus its staff-gate bypass tests (the pattern for "wrong
  caller → 404/403").
- `backend/tests/projects.test.ts` — owner routes, and the
  `requireProjectOwnership` "not mine == doesn't exist → 404" idiom.
- `backend/tests/auditLog.test.ts` — asserting on `security_events` rows by
  type and severity.
- `backend/tests/sessions.test.ts` — session projection and revoke behaviour.
- `backend/tests/apiKeyAuth.test.ts` — secret-key tier gating, publishable →
  `api_key_tier_forbidden`, key-only request → `401` on a session route.
- `backend/tests/backendSdk.test.ts` — the real-HTTP SDK seam and its
  contract-version-mismatch case.

### Backend cases

New suite `backend/tests/projectManagement.test.ts` (or extend
`projects.test.ts`):

- **Owner reads, happy path.** Owner lists their Project's users / sessions /
  events; each response has the documented projection and only rows from that
  Project. Seed a second Project with its own users/sessions/events and assert
  **none** of them appear.
- **Isolation — owner of A vs. Project B (mutation-checked).** Owner of A
  calls every route with B's `:projectId` → `404` on all of them. Mutation:
  weaken `requireProjectOwnership` to drop the `owner_id` filter → this test
  must fail.
- **Owner session revoke.** Revokes an `ACTIVE` session → `200`, session row
  `REVOKED` with `revoked_reason = "owner_revoked"`, one `SESSION_REVOKED`
  event whose metadata identifies the owner as actor. A second `DELETE` on the
  same id → `404`. `DELETE` of a session in another Project → `404`.
- **Events filtering + pagination.** Seed >`limit` events of mixed types /
  users. Assert: `?eventType=` narrows to that type; `?userId=` narrows to
  that user; walking `nextCursor` yields disjoint pages that reassemble to the
  full ordered set; `nextCursor` is `null` on the final page; a garbage
  `?cursor=` → `400 cursor_invalid`; an unknown `?eventType=` → `400`.
- **Session list is ACTIVE-only.** Revoke one of a user's two sessions; the
  list returns only the live one; `?userId=` filter works.
- **Secret-key parity.** `GET /project/events` and `GET /project/sessions`
  with a valid secret key return the same shapes; results are scoped to the
  key's Project (seed another Project + key, assert no cross-over —
  mutation-checked on the same-Project-different-nothing axis, i.e. drop the
  `project_id` filter and confirm the cross-Project test fails). A publishable
  key → `403 api_key_tier_forbidden`. A key-only request (no session) to any
  owner route (`/projects/:id/...`) → `401`.
- **Write routes still reject a key.** `DELETE /projects/:id/sessions/:sid`
  and `PATCH /projects/:id` with only `x-api-key` and no session → `401`
  (regression guard for story 18).

### SDK cases (`backendSdk.test.ts`)

- `listSessions()` against the test server returns a typed `Page`; `items`
  carry the summary fields; a Project with more than one page round-trips via
  `nextCursor`.
- `listEvents({ eventType: "LOGIN_FAILED" })` returns only that type;
  `listEvents({ userId })` filters; pagination round-trips.
- A contract-version mismatch still throws `ContractVersionMismatchError`
  before the body is read (existing behaviour, just confirm it holds for the
  new methods).

### Mutation-checked

The two isolation boundaries (owner-of-A ↛ Project B; secret-key-of-A ↛
Project B events/sessions) and the "owner write route rejects a key" gate.
Per the ticket-02 note in the wayfinder memory, the cross-Project assertion
that actually catches a dropped scope on a `user_id`-free query is the
**same-instance-different-Project** case — seed two Projects and confirm the
filter, don't rely on a `user_id`-scoped query making it a no-op.

## Out of Scope

- Any tenant-admin **role** or end-user-governs-end-user model — the grilling
  (round-1 Q2) chose not to build it; `Role.ADMIN` stays inert in tenant
  Projects and ADR 0007's deferral stands.
- Team / multi-developer ownership of one Project (still a parked
  clerk-clone-map item).
- Write access to users (create / edit / delete a Project's end users from
  the owner surface) — reads and session-revoke only this epic.
- Per-Project OAuth credentials — the other epic-2 spec
  (`.scratch/project-oauth/spec.md`), including the `GET /oauth/providers`
  `?projectId=` change.
- A `status` filter or revoked-session history on the session list — `ACTIVE`
  only for v1.
- Retention / export of the event log beyond what the cleanup job (ADR 0004)
  already does.
- Rate limiting the new read routes beyond what `requireAuth` /
  `requireSecretKey` and the global limiter already impose.
- Docs-sync itself — its own ticket.

## Further Notes

- **The directory name is misleading and that is deliberate-for-continuity.**
  If a future reader greps `tenant-rbac` expecting a role model, this spec is
  the correction: no role, owner surface only.
- The contract bump is **shared with `project-oauth`** — do not bump twice.
  The batch order puts this half first, so this is where `0.7.0` lands.
- The events `metadata` pass-through relies on the existing `CLAUDE.md`
  invariant ("Never put tokens, hashes, or credentials in `metadata`"). If a
  future event type needs to stash something sensitive, that is the moment to
  add redaction here — not now.
- Keyset pagination (not `OFFSET`) is chosen so a busy Project's log stays
  correct under concurrent writes while an owner pages through it.

## Tickets

Per the plan (`.scratch/deferred-closeout/plan.md`), and matching the
register-oracle shape (backend / SDK+contract / docs-sync):

1. **Backend.** The five owner routes + `requireProjectOwnership` reuse, the
   two mirrored secret-key routes, the shared query/serialize layer,
   `lib/pagination.ts`, the `SESSION_REVOKED` actor attribution, the contract
   bump to `0.7.0` across `backend/package.json` + both SDK `version.ts` /
   `package.json`, and all backend + parity tests.
2. **`backend-sdk` + changelog.** `listSessions()` / `listEvents()`, the
   `request()` query extension, the new exported types, `backendSdk.test.ts`
   cases, changelog entries in both SDK packages. Blocked by 1.
3. **Docs-sync.** `docs/roadmap.md` (the RBAC-enforcement section / the
   "Next up" list — record the owner surface as shipped), `CLAUDE.md`'s
   `routes/` inventory line if it enumerates them, `backend/README.md` and the
   SDK READMEs if they name the contract version or the surface. May fold into
   ticket 2's merge if they land together. Blocked by 2.
