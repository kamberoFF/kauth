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

**Status:** done

- [x] A logged-in project owner can generate a publishable key and a secret
      key for their project
- [x] The secret key's raw value is returned exactly once, at creation, and
      is never retrievable again afterward
- [x] The publishable key remains retrievable in full at any time
- [x] A listing of a project's keys shows a truncated prefix per key, never
      the full secret
- [x] A request bearing a publishable key can successfully initiate
      signup/login but is rejected from elevated operations (verify
      session, list users, revoke session)
- [x] A request bearing a secret key succeeds at the elevated operations
      above
- [x] A request bearing either key tier is rejected from project-management
      actions (rename project, rotate/revoke another key, delete project) —
      those succeed only via an authenticated developer session
- [x] Revoking a key immediately rejects further requests bearing it, while
      the key's own row and audit history remain queryable, never deleted
- [x] Key issuance and revocation each produce an audit event, following
      the existing severity-by-event-type convention
- [x] Integration tests cover both key tiers' allowed and rejected
      operations explicitly, including the boundary cases (publishable key
      attempting elevated ops, secret key attempting project-management
      ops)

## Comments

**2026-08-22 — implementation plan drafted, not yet started.** Full design
below, arrived at via three parallel Explore passes over the current schema/
middleware/controller/test conventions plus a dedicated Plan pass. Ready for
`/implement` to pick up directly — no further design work needed first.

### Resolved decisions

- **Wire format:** a dedicated `X-Api-Key` header, not `Authorization:
  Bearer` (that header is already unconditionally owned by `requireAuth`'s
  session/JWT check; kauth's own idiom is small dedicated headers —
  `x-project-id`, `x-device-id`, `x-csrf-token` — rather than overloading one
  generic channel).
- **Elevated-ops routes take no `:projectId` param** — `GET /project/users`,
  `GET /project/sessions/:sessionId`, `DELETE /project/sessions/:sessionId`,
  gated by a new `requireSecretKey` middleware. The secret key itself
  resolves the project (mirroring how `refresh` already derives project from
  the stored token row, not a client header), so these are flat and
  implicitly scoped. Deliberately distinct from the existing self-service
  `/sessions/:sessionId` (user-scoped, session-auth only) — reusing that
  route would silently widen an existing security boundary.
- **Key-management routes nested under `/projects/:projectId/keys`**
  (`POST`/`GET` list / `GET :keyId` / `DELETE :keyId`), gated by `requireAuth`
  + a new `requireProjectOwnership` middleware. These routes never inspect
  `X-Api-Key` at all — a key-only request 401s on `requireAuth` before any
  key logic runs, which is the entire mechanism satisfying "neither key tier
  can reach project-management actions."
- **Publishable-key-gated signup/login:** `POST /register`/`POST /login` keep
  their controllers untouched; swap their `requireProject` middleware for a
  new `resolveProjectFromKeyOrHeader` — if `X-Api-Key` is present it resolves
  the project and wins, otherwise falls back to today's `x-project-id`
  header. Secret keys also work here (elevated is a superset of
  publishable).
- **Ownership check** (`requireProjectOwnership`, new — no such helper
  exists pre-ticket): validates `req.params.projectId`, loads the project,
  requires `owner_id === req.userId`, collapses "doesn't exist" and "isn't
  yours" into one 404 `project_not_found` — same idiom as `revokeSession` /
  `unlinkAccount`.
- **No new rate limiter** in this ticket — `globalLimiter`/`byAccount`
  already apply to key-authenticated traffic unmodified. A key-id-keyed
  limiter is a named follow-up nuance, not an AC; deferring it is a stated
  decision.
- **`last_used_at` on `ApiKey` is schema-only in this ticket** — not written
  on every key-authenticated request, to avoid a write on the hot path for a
  field no AC needs. A later ticket can wire it up the way
  `Session.last_used_at` already is.

### Schema (`backend/prisma/schema.prisma`)

New model after `RecoveryToken`:

```prisma
model ApiKey {
  id String @id @default(uuid()) @db.Uuid

  project    Project @relation(fields: [project_id], references: [id], onDelete: Restrict)
  project_id String  @db.Uuid

  key_type ApiKeyType

  /**
   * SECRET: the plaintext lookup selector, paired with key_hash — the same
   * selector/verifier split RefreshToken uses for O(1) lookup without a
   * full-table hash scan. PUBLISHABLE: a display-truncated slice of
   * key_value. Either way, a listing shows only this column, never
   * key_value or key_hash.
   */
  key_prefix String  @unique

  /** Full plaintext value, PUBLISHABLE only — safe to re-serve in full. */
  key_value  String? @unique

  /** bcrypt hash of the verifier half, SECRET only. Shown once, never again. */
  key_hash String?

  created_by         User?   @relation("ApiKeyIssuer", fields: [created_by_user_id], references: [id], onDelete: SetNull)
  created_by_user_id String? @db.Uuid

  created_at   DateTime  @default(now())
  last_used_at DateTime?
  revoked_at   DateTime?

  @@index([project_id])
  @@index([created_by_user_id])
  @@map("api_keys")
}

enum ApiKeyType {
  PUBLISHABLE
  SECRET
}
```

Add `Project.apiKeys ApiKey[]` and `User.issuedApiKeys ApiKey[]
@relation("ApiKeyIssuer")`. Extend `SecurityEventType` with
`API_KEY_ISSUED`/`API_KEY_REVOKED`. `key_value`/`key_hash` nullable
`@unique` is safe — Postgres allows multiple NULLs, so the two tiers never
collide on the other's column. Migrate via `bunx --bun prisma migrate dev
--name add_api_keys` from `backend/`.

### New/changed files

- **`backend/lib/apiKeys.ts`** (new) — generation mirrors two existing
  patterns exactly: secret keys reuse `lib/sessions.ts`'s selector+bcrypt-
  verifier split (`sk_<selector>.<verifier>`, bcrypt rounds matching
  `REFRESH_HASH_ROUNDS`); publishable keys (`pk_<random>`) stored fully in
  plaintext. `resolveApiKey(raw)` parses by prefix, looks up by `key_value`
  (publishable) or `key_prefix` + `bcrypt.compare` (secret), returns the row,
  the sentinel `"revoked"` (so the middleware can answer `api_key_revoked`
  vs `api_key_invalid` without a second query), or `null`.
- **`backend/constants/headers.ts`** — add `API_KEY_HEADER = "x-api-key"`.
- **`backend/constants/apiKeys.ts`** (new) — key prefixes, bcrypt rounds.
- **`backend/types/express.d.ts`** — add `apiKeyId?: string`,
  `apiKeyType?: "PUBLISHABLE" | "SECRET"`.
- **`backend/middlewares/apiKey.ts`** (new) — `requireApiKey` (either tier),
  `requireSecretKey` (secret only, 403 `api_key_tier_forbidden` otherwise),
  `resolveProjectFromKeyOrHeader` (register/login only, described above).
- **`backend/middlewares/projectOwnership.ts`** (new) —
  `requireProjectOwnership`, described above.
- **`backend/lib/validation.ts`** — add `issueApiKeySchema = z.object({
  type: z.enum(["PUBLISHABLE", "SECRET"]) })`.
- **`backend/controllers/apiKeys.ts`** (new) — `issueApiKey` (201s with the
  one-time full raw `value`, writes `API_KEY_ISSUED` in the same
  transaction), `listApiKeys` (`{ id, type, prefix, createdAt, lastUsedAt,
  revokedAt }[]`, never `value`), `getApiKey` (adds `value`: full
  `key_value` for `PUBLISHABLE`, always `null` for `SECRET`), `revokeApiKey`
  (already-revoked collapses into 404 `api_key_not_found`, writes
  `API_KEY_REVOKED`).
- **`backend/controllers/projectAccess.ts`** (new) — `listProjectUsers`
  (`where: { project_id: req.projectId }`, no pagination), `verifyProjectSession`
  (scoped lookup, 404 `session_not_found` if foreign/absent),
  `revokeProjectSession` (reuses `lib/sessions.ts`'s `revokeSessions(tx, {
  id, project_id: req.projectId }, "api_key_revoked")` — no `user_id`
  filter, since a secret key may revoke any end user's session in its
  project — writes `SESSION_REVOKED` with `userId` from the revoked row, not
  `req.userId`, which doesn't exist here).
- **`backend/routes/projects.ts`** — add the four `/projects/:projectId/keys`
  routes (`requireAuth`, `requireProjectOwnership`).
- **`backend/routes/projectAccess.ts`** (new) — the three `/project/...`
  routes (`requireSecretKey`).
- **`backend/routes/auth.ts`** — swap `requireProject` for
  `resolveProjectFromKeyOrHeader` on `/register` and `/login` only;
  `/refresh`/`/logout` untouched.
- **`backend/app.ts`** — mount `routes/projectAccess.ts`, add
  `API_KEY_HEADER` to the CORS `allowedHeaders` list.
- **`backend/lib/securityEvents.ts`** — `SEVERITY` map gets `API_KEY_ISSUED:
  INFO`, `API_KEY_REVOKED: WARNING`. Metadata on both:
  `{ apiKeyId, keyType, prefix }` — never the hash or raw value.
- **`backend/tests/helpers/api.ts`** — add `ApiOptions.apiKey?: string` →
  `X-Api-Key` header; add `createOwnedProject()` (register a developer into
  `PLATFORM_PROJECT_ID`, log in, `POST /projects`) since both new suites
  need it repeatedly.
- **`backend/tests/apiKeys.test.ts`** (new) — issue/list/get/revoke
  lifecycle, ownership 404s, revoked-not-deleted, audit rows. Mutation
  check: drop `project_id` from `listApiKeys`'s `where`, confirm the
  cross-project listing test goes red.
- **`backend/tests/apiKeyAuth.test.ts`** (new) — the tier/boundary matrix:
  publishable succeeds at register/login, 403s on all `/project/...` routes,
  401s on `/projects/:id/keys/*`; secret succeeds at register/login + all
  `/project/...` routes, 401s on `/projects/:id/keys/*` same as publishable;
  revoked → `api_key_revoked` everywhere; malformed → `api_key_invalid`;
  cross-project isolation on `/project/users`. Mutation checks: (a) remove
  the tier branch in `requireSecretKey`, confirm publishable-rejected tests
  go red; (b) drop `owner_id` from `requireProjectOwnership`'s query,
  confirm the project-management-rejected-for-either-tier test goes red.

### Sequencing

Schema/migration → `SEVERITY` map entries (compiler-enforced first) →
constants → `lib/apiKeys.ts` → `types/express.d.ts` → middlewares →
controllers → routes/wiring → test helpers → `apiKeys.test.ts` →
`apiKeyAuth.test.ts` — `bun run typecheck` and targeted `bun test <file>`
after each stage, full `bun test` once at the end, each mutation check
triggered once for real before trusting it.

### Closing out

Per `docs/agents/issue-tracker.md`: the commit that merges this ticket also
sets `Status: done` above and checks every satisfied box. Branch name
convention from prior tickets: `ticket-04-api-key-issuance...`, merged with
a `Merge ticket-04-...: <summary>` message.

**2026-08-23 — implemented, all boxes checked.** Built exactly per the plan
above, no deviations of substance. `ApiKey` model + `ApiKeyType` enum +
`API_KEY_ISSUED`/`API_KEY_REVOKED` migrated
(`20260822210807_add_api_keys`); `lib/apiKeys.ts`, `middlewares/apiKey.ts`
(`requireApiKey`/`requireSecretKey`/`resolveProjectFromKeyOrHeader`),
`middlewares/projectOwnership.ts`, `controllers/apiKeys.ts`,
`controllers/projectAccess.ts`, the `/projects/:projectId/keys` and
`/project/...` routes, and the `resolveProjectFromKeyOrHeader` swap on
`/register`/`/login` all landed as designed. `RevocationReason` in
`lib/sessions.ts` gained an `"api_key_revoked"` member (not called out
explicitly in the plan's decision list, but required by
`revokeProjectSession` reusing `revokeSessions`).

Two new suites: `tests/apiKeys.test.ts` (18 tests — lifecycle, ownership
404s, revoked-not-deleted, audit rows) and `tests/apiKeyAuth.test.ts` (18
tests — the tier/boundary matrix, cross-project isolation, revoked/malformed
key handling). Full suite: **180 pass / 0 fail** (up from the 138 recorded
after ticket 03). All three planned mutation checks were triggered for
real — project-scoping in `listApiKeys`, the tier branch in
`requireSecretKey`, and the ownership condition in
`requireProjectOwnership` — each confirmed red, then restored.
`bun run typecheck` and `bun run lint` both clean. Manual smoke test against
`bun run dev`: `/health` OK, an unknown `x-api-key` on `/project/users`
correctly returns `401 api_key_invalid`.
