# 02 — Project sessions & users: owner surface + secret-key session list

Status: done

**What to build:** a Project owner can see and manage the sessions and users
inside their own Project from their developer session, and a Project's secret
key gains a Project-wide session list.

- **`GET /projects/:projectId/sessions`** — owner session. Lists the
  Project's `ACTIVE` sessions (matching every other session list in kauth —
  revocation history lives in the event log). Optional `?userId=` filter
  (UUID or `400`). Keyset-paginated with the ticket-01 helper. Management
  projection: `id`, `userId`, `status`, `deviceId`, `deviceName`,
  `deviceType`, `osName`, `osVersion`, `browserName`, `browserVersion`,
  `ipCreated`, `ipLast`, `countryCreated`, `countryLast`, `cityCreated`,
  `cityLast`, `createdAt`, `lastUsedAt`, `expiresAt`. No `current` flag.
  Response `{ sessions: [...], nextCursor: string | null }`.
- **`GET /projects/:projectId/sessions/:sessionId`** — owner session. Single
  session scoped to the Project: `id`, `userId`, `status`, `createdAt`,
  `lastUsedAt`, `expiresAt`, `revokedAt`. `400` on a malformed id, `404` on a
  miss or a cross-Project id.
- **`DELETE /projects/:projectId/sessions/:sessionId`** — owner session.
  Revokes any `ACTIVE` session in the Project (`revoked_reason =
  "owner_revoked"`). A non-existent / already-revoked / cross-Project id is a
  clean `404`. Writes one `SESSION_REVOKED` event in the same transaction,
  identifying the owner as the actor.
- **`GET /projects/:projectId/users`** — owner session. Lists the Project's
  users: `id`, `email`, `username`, `emailVerified`, `role`, `createdAt`,
  ordered `created_at asc`. Reuses the shared user serializer from ticket 01
  (not a fourth copy).
- **`GET /project/sessions`** — secret key. Same query, projection, filters,
  and paging as the owner session list, Project taken from the key. Coexists
  with the existing `GET /project/sessions/:sessionId`.
- Every route: a Project that is not the caller's == one that does not exist
  == `404`. A key-only request to any `/projects/:projectId/*` route → `401`.

**Implementation notes (from `.scratch/tenant-rbac/spec.md`):**

- **`SESSION_REVOKED` actor normalization.** Today the metadata varies by
  caller: `{ apiKeyId }` (secret-key path), `{ actor_user_id }` (staff path),
  absent (self-service). Normalize all call sites (including this ticket's new
  owner path) to a single discriminator: `metadata.actor` one of
  `"self" | "owner" | "staff" | "api_key"`, plus `actor_user_id` for
  `owner`/`staff` and `api_key_id` for `api_key`. Update the affected tests
  (`sessions.test.ts`, `adminSurface.test.ts`, `projectAccess`-related
  suites). If this is judged too broad for the ticket, add only the `owner`
  marker and say so in the ticket comments — but the normalized form is
  preferred and makes ticket 01's events endpoint legible.
- Session list is `ACTIVE`-only on both surfaces; no `?status=` filter this
  epic.
- Owner routes mount alongside the existing owner routes
  (`routes/projects.ts`) or a new `routes/projectManagement.ts` —
  implementer's call; all behind `requireAuth, requireProjectOwnership`.
- Reuse `lib/pagination.ts` and the shared query/serialize module from
  ticket 01 — no divergent projection copies.
- `revokeSessions(tx, { id, project_id }, "owner_revoked")` is the revoke
  primitive; the empty-result-is-404 idiom matches
  `controllers/projectAccess.ts:revokeProjectSession`.

**Blocked by:** 01 (contract bump, `lib/pagination.ts`, shared serialize
layer)

- [x] `GET /projects/:projectId/sessions` returns the owner's Project's `ACTIVE` sessions in the documented projection; a revoked session does not appear; `?userId=` filters; pagination round-trips via `nextCursor`
- [x] `GET /projects/:projectId/sessions/:sessionId` returns one session scoped to the Project; malformed id → `400`; miss or cross-Project id → `404`
- [x] `DELETE /projects/:projectId/sessions/:sessionId` revokes an `ACTIVE` session (`revoked_reason = "owner_revoked"`) and writes one `SESSION_REVOKED` event with the owner as actor; a second `DELETE` → `404`; a `DELETE` of another Project's session → `404`
- [x] `GET /projects/:projectId/users` lists the Project's users in the documented shape via the shared serializer
- [x] Owner of Project A hits every route with Project B's id → `404` on all of them (mutation-checked against the `owner_id` filter)
- [x] `GET /project/sessions` returns the same shape with a valid secret key, scoped to the key's Project; another Project's sessions never appear (mutation-checked against the `project_id` filter)
- [x] A request bearing only `x-api-key` (no session) to `DELETE /projects/:projectId/sessions/:sessionId` and to `PATCH /projects/:projectId` → `401`
- [x] `SESSION_REVOKED` metadata uses the normalized `actor` discriminator across all call sites and their tests are updated
- [x] `bun test`, `bun run typecheck`, `bun run lint` all green

## Implementation comments

- **Actor normalization: did the full cleanup** (the preferred option, not the
  fallback). `SESSION_REVOKED` metadata is now `{ actor, ... }` at every call
  site: `{ actor: "self" }` (`controllers/sessions.ts`),
  `{ actor: "staff", actor_user_id }` (`controllers/admin.ts`),
  `{ actor: "api_key", api_key_id }` (`controllers/projectAccess.ts`, renamed
  from the old `{ apiKeyId }`), `{ actor: "owner", actor_user_id }` (new owner
  path). The discriminated union `SessionRevocationActor` lives in
  `lib/securityEvents.ts`. Tests updated in `adminSurface`, `sessions`,
  `auditLog`, `apiKeyAuth`.
- **Shared layer.** `lib/projectManagement.ts` grew `listProjectUsers`,
  `listProjectSessions`, `getProjectSession`, and `revokeProjectSession` (the
  owner/secret-key revoke primitive, differing only in `reason` + actor).
  `controllers/projectAccess.ts` and `controllers/admin.ts:listProjectUsers`
  were refactored onto these — no divergent projection copies.
- **`requireApiKeyId`** added to `utils/requestGuards.ts` so the `api_key`
  actor id is a checked `string`, not `string | undefined`.
- Both cross-Project isolation boundaries were mutation-checked: dropping the
  `owner_id` filter and dropping the `project_id` filter each make the
  relevant test fail.
- No contract bump — ticket 01 already put `0.7.0` in place; verified
  `contractVersion.test.ts` still green.

### Post-`/code-review` cleanup

- `recordSessionRevoked(client, { userId, sessionId, projectId, actor,
  context })` added to `lib/securityEvents.ts` — the single writer of a
  `SESSION_REVOKED` row, so the four surfaces cannot drift and `actor` is
  type-checked at every call site (the review flagged the write shape as the
  third DRY case and the union as declared-but-unenforced).
- `revokeProjectSession` (lib) dropped its `reason` param; `revoked_reason` is
  now derived from `actor.actor` via `REVOCATION_REASON_BY_ACTOR`, so a caller
  can't set the column and the audit metadata out of lockstep.
- `ManagementListQuery` now `extends SessionListQuery`.
