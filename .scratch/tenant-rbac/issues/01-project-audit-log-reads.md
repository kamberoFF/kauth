# 01 — Project audit log: owner + secret-key reads

Status: ready-for-agent

**What to build:** a Project's `security_events` become readable two ways —
by the Project **owner's** developer session, and by the Project's **secret
API key** — without either being able to see any other Project's events.

- **`GET /projects/:projectId/events`** — owner session
  (`requireAuth` + `requireProjectOwnership`). Returns the Project's security
  events, newest first, keyset-paginated (`?limit=`, default 50, clamped
  1–200; `?cursor=`), filterable by `?eventType=` (repeatable or
  comma-separated; every value validated against `SecurityEventType` or
  `400`) and `?userId=` (UUID or `400`). Projection per event: `id`,
  `eventType`, `severity`, `userId`, `sessionId`, `ip`, `userAgent`,
  `metadata`, `createdAt`. `metadata` is returned exactly as stored. Response:
  `{ events: [...], nextCursor: string | null }`.
- **`GET /project/events`** — the same query, projection, filters, and paging,
  behind `requireSecretKey`, with the Project taken from the key
  (`req.projectId`), path flat like the other `/project/*` routes. A
  publishable key → `403 api_key_tier_forbidden`; a key-only request never
  reaches the owner route (it `401`s at `requireAuth`).
- A Project that is not the caller's, and one that does not exist, both return
  the same `404` on the owner route.

This ticket also lands the epic-wide plumbing the sessions ticket reuses:

- **Contract version → `0.7.0`** — `backend/package.json`, and
  `packages/backend-sdk` + `packages/client-sdk` `version.ts`
  (`CONTRACT_VERSION`) and `package.json`, all in lockstep; changelog note in
  both SDK packages. This is the **single** epic-2 bump — `project-oauth`
  checks it and does not re-bump. `contractVersion.test.ts` stays green.
- A **keyset pagination helper** (`lib/pagination.ts`): opaque base64url
  cursor encoding the last row's `{ createdAt, id }`; a real
  `WHERE (created_at, id) < (...)` predicate, not `OFFSET`; fetch `limit + 1`
  to detect a next page; decode failure → `400 cursor_invalid`.
- A **shared query/serialize module** for the Project-scoped management reads,
  callable from both the owner controller and the secret-key controller — the
  only difference between callers is how `req.projectId` was resolved. The
  duplicated `serializeUser` in `controllers/projectAccess.ts` and
  `controllers/admin.ts` folds into it as a prefactor (no behaviour change).

**Implementation notes (from `.scratch/tenant-rbac/spec.md`):**

- No schema change and no migration in this epic — `security_events` already
  carries everything.
- `requireProjectOwnership` is reused unchanged (validates `:projectId`,
  checks `owner_id`, collapses missing-or-not-owned into one `404`, sets
  `req.projectId`).
- `metadata` pass-through relies on the existing `CLAUDE.md` invariant that
  tokens/hashes/credentials never go in `metadata`; the identifiers that do
  (`provider`, `actor_user_id`, `old_role`/`new_role`, `apiKeyId`) are things
  an owner may see about their own Project.
- Keyset ordering is `created_at desc, id desc` on both surfaces.
- Advertising `0.7.0` before any `0.7.0`-only behaviour ships is fine —
  greenfield, no deployments, SDKs bump in lockstep (per the decision
  profile: bump in the ticket that makes the contract change).

**Blocked by:** None — can start immediately

- [ ] `GET /projects/:projectId/events` returns the owning developer's Project events in the documented shape, newest first
- [ ] `?eventType=` (single, and comma-separated multi) narrows results; an unknown event type → `400`
- [ ] `?userId=` narrows results; a malformed id → `400`
- [ ] Walking `nextCursor` yields disjoint pages that reassemble to the full ordered set; `nextCursor` is `null` on the last page; a garbage `?cursor=` → `400 cursor_invalid`; `?limit=` is clamped to 1–200
- [ ] Owner of Project A calling the route with Project B's id → `404`; **mutation check:** dropping the `owner_id` filter in `requireProjectOwnership` makes this fail
- [ ] `GET /project/events` returns the same shape with a valid secret key, scoped to the key's Project; a second Project's events never appear; **mutation check:** dropping the `project_id` filter makes the cross-Project test fail
- [ ] `GET /project/events` with a publishable key → `403 api_key_tier_forbidden`; the owner route with only `x-api-key` and no session → `401`
- [ ] `backend/package.json`, both SDK `version.ts` (`CONTRACT_VERSION`), and both SDK `package.json` are all `0.7.0`; `contractVersion.test.ts` passes; both SDK changelogs note the bump
- [ ] `lib/pagination.ts` exists and is used by the events endpoints; the shared query/serialize module is used by both the owner and secret-key controllers with no divergent projection copy
- [ ] `bun test`, `bun run typecheck`, `bun run lint` all green
