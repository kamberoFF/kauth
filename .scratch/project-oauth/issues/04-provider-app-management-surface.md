# 04 — Provider app management surface

Status: done

**What to build:** a Project owner configures, disables, and clears their
Project's Provider apps from their developer session — and can never read a
stored secret back, nor find one in an audit event or a log line.

- **`GET /projects/:projectId/oauth/providers`** — owner session
  (`requireAuth` + `requireProjectOwnership`). One entry per built-in
  provider: `{ provider, source: "instance" | "project", enabled, clientId }`.
  `clientId` non-null only when `source === "project"`. Never the secret.
- **`PUT /projects/:projectId/oauth/providers/:provider`** — `:provider` a
  known built-in id or `400 provider_not_found`. Body, zod-validated, is
  exactly one of:
  - `{ clientId, clientSecret }` → upsert `mode = OVERRIDE`, secret encrypted
    under `"kauth:project-oauth"`.
  - `{ disabled: true }` → upsert `mode = DISABLED`, secret null.
  - anything else → `400 validation`.
  Returns the same shape as one `GET` entry.
- **`DELETE /projects/:projectId/oauth/providers/:provider`** — drops the row
  (back to inherit); `404` if there is no row.
- Every successful `PUT` / `DELETE` writes one `PROJECT_OAUTH_CONFIG_CHANGED`
  in the **same transaction** as the row write — metadata
  `{ provider, action: "configured" | "disabled" | "cleared" }`, no secret,
  no `client_id`.
- Writes are owner-session only: a request bearing only `x-api-key` → `401`
  at `requireAuth`; a non-owner developer session → `404`.
- No live credential validation against the provider.

**Implementation notes (from `.scratch/project-oauth/spec.md`):**

- Mounts alongside the other owner routes, behind `requireAuth,
  requireProjectOwnership`.
- Prior art: `backend/tests/projects.test.ts` (owner routes,
  `requireProjectOwnership` 404 idiom), `backend/tests/apiKeyAuth.test.ts`
  (key-only → `401` on a session route),
  `backend/tests/configEncryptionKey.test.ts` (encryption-at-rest
  assertions), `backend/tests/mfaSecurityEvents.test.ts`
  (policy-change-event assertions).

**Blocked by:** 03 (the `ProjectOAuthCredential` table,
`enabledProvidersForProject`, and the `PROJECT_OAUTH_CONFIG_CHANGED` enum
value)

- [x] Owner can `GET` the effective provider list, `PUT` an `OVERRIDE`, `PUT` `{ disabled: true }`, and `DELETE` a row; the effects match what `GET /oauth/providers?projectId=` reports and what the OAuth flow resolves
- [x] `GET` never returns a secret; a `PUT` body that is neither `{clientId,clientSecret}` nor `{disabled:true}` → `400`; an unknown `:provider` → `400`
- [x] After a `PUT { clientId, clientSecret }`: the row's `client_secret_enc` ≠ the plaintext and round-trips through `cryptoBox`; the `GET` response contains no substring of the secret
- [x] Each of configure / disable / clear writes exactly one `PROJECT_OAUTH_CONFIG_CHANGED` (severity `WARNING`, attributed to the owner and Project) whose metadata contains neither the secret nor the `client_id`
- [x] A non-owner developer session → `404` on all three routes; **mutation check:** dropping the `owner_id` filter in `requireProjectOwnership` makes this fail
- [x] A request with only `x-api-key` (no session) → `401` on all three routes
- [x] `bun test`, `bun run typecheck`, `bun run lint` all green

---

Implemented (`/implement`; `/tdd` seam = the owner-route HTTP idiom against real
Postgres).

**Surface.** `controllers/projectOAuthProviders.ts` —
`listProjectOAuthProviders` / `putProjectOAuthProvider` /
`deleteProjectOAuthProvider`, mounted in `routes/projects.ts` under
`/projects/:projectId/oauth/providers` behind `requireAuth,
requireProjectOwnership` (same never-reached-by-a-key rule as the sibling
owner routes). `GET` returns `{ providers: [...] }` over every built-in
provider id; `PUT` upserts `OVERRIDE` (secret `encrypt(_, PROJECT_OAUTH_CONTEXT)`)
or `DISABLED`, `DELETE` drops the row (`404 provider_not_configured` when
absent). Each `PUT` / `DELETE` writes one `PROJECT_OAUTH_CONFIG_CHANGED` in the
same `$transaction` — metadata `{ provider, action }` only.

**Validation.** `projectOAuthCredentialSchema` in `lib/validation.ts` — a
`.strict()` zod union so a half-filled `{ clientId }`, a `{ disabled: false }`,
or a merged body is `400 validation`. Unknown `:provider` (no factory) →
`400 provider_not_found`, checked before body parse.

**`lib/oauth/providers.ts`.** New `describeProjectProvider` (owner-listing
view), `hasOAuthProviderFactory` / `oauthProviderFactoryIds`, and
`overrideIsUsable` — the one predicate `resolveProjectProvider`,
`enabledProvidersForProject`, and the listing all share. Post-review:
`enabledProvidersForProject` now treats *any* Project row as shadowing the
instance default (matching `resolveProjectProvider`), so a malformed override
row can't have the login list and the flow disagree; `DELETE` uses a single
`deleteMany` + count check.

**Tests.** `tests/projectOAuthProviderManagement.test.ts` (6) — inherit →
override → disable → clear round trip with the effect verified on both the
discovery endpoint and the authorization start; malformed / merged / unknown
bodies; secret encrypted at rest under `PROJECT_OAUTH_CONTEXT` and absent from
the listing; one event per action, attributed and secret-free; non-owner `404`
(mutation-checked on the `owner_id` filter); key-only `401` (mutation-checked
on `requireAuth`). Full suite 477 pass / 0 fail; typecheck + lint green.
Contract stays `0.7.0`.
