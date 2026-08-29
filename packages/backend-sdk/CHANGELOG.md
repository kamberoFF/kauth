# Changelog

All notable changes to `@kauth/backend-sdk`. The version is kept in lockstep
with the kauth server's contract version (ADR 0003) — a bump here means the
whole contract moved, even when this package's own API did not.

## 0.7.0

- **`listSessions(options?)` and `listEvents(options?)`.** Two new reads over
  the calling Project's own data, backing the server's Project owner
  management surface (`.scratch/tenant-rbac/`):
  - `listSessions({ userId?, limit?, cursor? })` → the Project's `ACTIVE`
    sessions, reverse-chronological, optionally narrowed to one user.
  - `listEvents({ eventType?, userId?, limit?, cursor? })` → the Project's
    `security_events`, reverse-chronological, filterable by type (one or
    several) and user.
  - Both return a `Page<T>` = `{ items, nextCursor }`; pass `nextCursor` back
    as `cursor` to walk pages. New exported types: `Page`,
    `KauthSessionSummary`, `KauthSecurityEvent`, `ListSessionsOptions`,
    `ListEventsOptions`.
  - `verifySession` / `listUsers` / `revokeSession` are unchanged;
    `listUsers` stays non-paginated.
- **Coordinated contract bump.** `CONTRACT_VERSION` and the package version
  move to `0.7.0` so a coordinated redeploy has a single version to align on.
  This is the single bump for the whole epic — the per-Project OAuth half
  rides the same number.

## 0.6.0

- **Coordinated contract bump, no API change.** `POST /register` on the
  server stopped returning a session (register drops auto-login — ADR 0008,
  contract → `0.6.0`). This package has no register method and is otherwise
  unaffected, but its `CONTRACT_VERSION` and package version move to `0.6.0`
  so a coordinated redeploy has a single version to align on.

_Earlier versions predate this file; see the git history and `docs/roadmap.md`._
