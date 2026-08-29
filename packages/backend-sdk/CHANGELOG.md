# Changelog

All notable changes to `@kauth/backend-sdk`. The version is kept in lockstep
with the kauth server's contract version (ADR 0003) — a bump here means the
whole contract moved, even when this package's own API did not.

## 0.7.0

- **Coordinated contract bump for the Project owner management surface.** The
  server gained owner- and secret-key-authenticated reads over a Project's
  own security events and sessions (`.scratch/tenant-rbac/`). This entry
  covers only the contract move to `0.7.0`; the SDK methods that consume the
  new reads (`listEvents()`, `listSessions()`) land in a follow-up within the
  same version. `CONTRACT_VERSION` and the package version move to `0.7.0` so
  a coordinated redeploy has a single version to align on. This is the single
  bump for the whole epic — the per-Project OAuth half rides the same number.

## 0.6.0

- **Coordinated contract bump, no API change.** `POST /register` on the
  server stopped returning a session (register drops auto-login — ADR 0008,
  contract → `0.6.0`). This package has no register method and is otherwise
  unaffected, but its `CONTRACT_VERSION` and package version move to `0.6.0`
  so a coordinated redeploy has a single version to align on.

_Earlier versions predate this file; see the git history and `docs/roadmap.md`._
