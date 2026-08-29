# 03 — backend-sdk: listEvents() / listSessions()

Status: done

**What to build:** the `backend-sdk` package exposes the two new Project
reads as typed, cursor-paginated methods, so a downstream backend does not
hand-roll the HTTP or the paging.

- **`listEvents(options?): Promise<Page<KauthSecurityEvent>>`** →
  `GET /project/events`. `options` = `{ eventType?: string | string[];
  userId?: string; limit?: number; cursor?: string }`.
- **`listSessions(options?): Promise<Page<KauthSessionSummary>>`** →
  `GET /project/sessions`. `options` = `{ userId?: string; limit?: number;
  cursor?: string }`.
- `Page<T>` = `{ items: T[]; nextCursor: string | null }`. New exported
  types: `Page`, `KauthSecurityEvent` (with `metadata: Record<string,
  unknown> | null`), `KauthSessionSummary`, `ListEventsOptions`,
  `ListSessionsOptions`.
- The existing contract-version-mismatch behaviour still fires first on these
  methods (a stale SDK throws `ContractVersionMismatchError` before the body
  is read).
- `verifySession` / `listUsers` / `revokeSession` are unchanged; `listUsers`
  stays non-paginated.
- Changelog entries in both SDK packages. `client-sdk` has no API change this
  epic — its version was bumped in ticket 01 (lockstep); confirm its
  changelog notes that.

**Implementation notes (from `.scratch/tenant-rbac/spec.md`):**

- The internal `request(method, path)` helper in
  `packages/backend-sdk/src/index.ts` gains an optional query-params argument
  so the list methods can pass `limit` / `cursor` / `userId` / `eventType`.
- The wire response is `{ events | sessions: [...], nextCursor }`; the SDK
  maps it to `{ items, nextCursor }`.
- Tested at the existing real-HTTP SDK seam (`backendSdk.test.ts`) against
  the running test server — no mocked transport.

**Blocked by:** 01, 02 (both `/project/events` and `/project/sessions` must
exist)

- [x] `listEvents()` against the test server returns a typed `Page`; `items` carry the documented event fields
- [x] `listEvents({ eventType: "LOGIN_FAILED" })` returns only that type; `listEvents({ userId })` filters; multi-page results round-trip via `nextCursor`
- [x] `listSessions()` returns a typed `Page` of session summaries; `{ userId }` filters; pagination round-trips
- [x] A contract-version mismatch throws `ContractVersionMismatchError` from both new methods before the body is parsed
- [x] New types are exported from the package entrypoint; `bun run typecheck` / build clean for the SDK package
- [x] Both SDK packages carry a changelog entry for `0.7.0`

## Implementation comments

- **`request()` query extension.** The internal helper gained an optional
  third arg `query?: Record<string, string | string[] | number | undefined>`.
  It builds a `URL`, appends each defined entry (arrays → repeated params, so
  `eventType: [...]` hits the server's repeat-or-comma parser), and `fetch`es
  the `URL`. `undefined` values are skipped, so `listSessions()` with no
  options sends a bare path.
- **Wire → SDK mapping.** `{ sessions | events, nextCursor }` from the server
  maps to `Page<T> = { items, nextCursor }`. New exported types: `Page<T>`,
  `KauthSessionSummary`, `KauthSecurityEvent` (`metadata: Record<string,
  unknown> | null`), `ListSessionsOptions`, `ListEventsOptions`.
- **Contract check unchanged.** Both methods route through `request()`, which
  calls `assertContractVersion` before `response.json()` — the mismatch fires
  first, confirmed by a new `backendSdk.test.ts` case exercising both methods.
- **`client-sdk`** has no API change; its `0.7.0` changelog entry (from
  ticket 01) already states the bump is lockstep-only. Left as-is.
- **Docs-sync (ticket 04) folded into this commit** — `docs/roadmap.md`, the
  `backend-sdk` README. `CLAUDE.md`'s Layout section describes `routes/` as
  "thin" without enumerating routes, and `backend/README.md`'s API tables
  never covered the owner / secret-key `/project/*` surface (tickets 01–02
  didn't add them either), so neither needed a contract-version or route edit.
