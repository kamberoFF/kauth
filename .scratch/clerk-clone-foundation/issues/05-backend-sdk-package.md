# 05 — Backend SDK package

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** A backend-only SDK package, authenticated with a
project's secret key, exposing session verification, user listing, and
session revocation as simple function calls that wrap the corresponding
secret-key-authenticated endpoints from ticket 04 over the network — proving
a downstream app's own server can integrate without ever handling raw HTTP
details itself.

**Blocked by:** 04 (done). The roadmap "Before starting the SDK" gate's last
open item — operations hardening — was satisfied 2026-08-24 by the
`ops-hardening` tickets; see `docs/roadmap.md`.

**Status:** done

- [x] The package is importable independently of the client package
      (ticket 06) — no shared bundle, no risk of a secret key ending up in
      client code by construction
- [x] `verifySession`-equivalent correctly confirms a live session and
      correctly rejects an expired, revoked, or reuse-flagged one,
      reflecting the platform's real-time revocation state rather than a
      cached/stale result
- [x] `listUsers`-equivalent and `revokeSession`-equivalent correctly scope
      to the calling project's own users only
- [x] Errors surface the platform's existing `{ code, message }` shape
      directly, not a generic wrapped error
- [x] Per ADR 0003: the server emits `X-Kauth-Contract-Version` on every
      response (kauth's own package version); the SDK checks it on every
      request and hard-fails on any exact mismatch with a clear message
      that the operation may already have completed server-side and must
      not be auto-retried
- [x] Integration tests exercise the package against a real running test
      server, per the spec's single confirmed seam — no mocked HTTP
      transport, including a version-mismatch test
