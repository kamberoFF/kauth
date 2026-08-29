# 03 — backend-sdk: listEvents() / listSessions()

Status: ready-for-agent

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

- [ ] `listEvents()` against the test server returns a typed `Page`; `items` carry the documented event fields
- [ ] `listEvents({ eventType: "LOGIN_FAILED" })` returns only that type; `listEvents({ userId })` filters; multi-page results round-trip via `nextCursor`
- [ ] `listSessions()` returns a typed `Page` of session summaries; `{ userId }` filters; pagination round-trips
- [ ] A contract-version mismatch throws `ContractVersionMismatchError` from both new methods before the body is parsed
- [ ] New types are exported from the package entrypoint; `bun run typecheck` / build clean for the SDK package
- [ ] Both SDK packages carry a changelog entry for `0.7.0`
