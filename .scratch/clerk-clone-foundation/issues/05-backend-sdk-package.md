# 05 — Backend SDK package

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** A backend-only SDK package, authenticated with a
project's secret key, exposing session verification, user listing, and
session revocation as simple function calls that wrap the corresponding
secret-key-authenticated endpoints from ticket 04 over the network — proving
a downstream app's own server can integrate without ever handling raw HTTP
details itself.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] The package is importable independently of the client package
      (ticket 06) — no shared bundle, no risk of a secret key ending up in
      client code by construction
- [ ] `verifySession`-equivalent correctly confirms a live session and
      correctly rejects an expired, revoked, or reuse-flagged one,
      reflecting the platform's real-time revocation state rather than a
      cached/stale result
- [ ] `listUsers`-equivalent and `revokeSession`-equivalent correctly scope
      to the calling project's own users only
- [ ] Errors surface the platform's existing `{ code, message }` shape
      directly, not a generic wrapped error
- [ ] Integration tests exercise the package against a real running test
      server, per the spec's single confirmed seam — no mocked HTTP
      transport
