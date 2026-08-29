# Changelog

All notable changes to `@kauth/client-sdk`. The version is kept in lockstep
with the kauth server's contract version (ADR 0003) — a bump here means the
whole contract moved, even when this package's own API did not.

## 0.7.0

- **Coordinated contract bump, no API change.** The server gained a Project
  owner management surface — owner- and secret-key-authenticated reads over a
  Project's own security events and sessions (`.scratch/tenant-rbac/`). None
  of it touches the browser/end-user auth surface this package drives, but its
  `CONTRACT_VERSION` and package version move to `0.7.0` so a coordinated
  redeploy has a single version to align on. This is the single bump for the
  whole epic — the per-Project OAuth half rides the same number.

_Earlier versions predate this file; see the git history, the README, and
`docs/roadmap.md`._
