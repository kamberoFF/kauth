# Changelog

All notable changes to `@kauth/backend-sdk`. The version is kept in lockstep
with the kauth server's contract version (ADR 0003) — a bump here means the
whole contract moved, even when this package's own API did not.

## 0.6.0

- **Coordinated contract bump, no API change.** `POST /register` on the
  server stopped returning a session (register drops auto-login — ADR 0008,
  contract → `0.6.0`). This package has no register method and is otherwise
  unaffected, but its `CONTRACT_VERSION` and package version move to `0.6.0`
  so a coordinated redeploy has a single version to align on.

_Earlier versions predate this file; see the git history and `docs/roadmap.md`._
