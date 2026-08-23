# 06 — Client SDK package

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** A browser/mobile-safe SDK package, authenticated with a
project's publishable key, exposing headless sign-up, sign-in, sign-out
functions and a reactive session hook for the first supported framework —
proving a developer can wire kauth into their own UI without touching raw
HTTP or cookie handling directly.

**Blocked by:** 04 (done), and `docs/roadmap.md`'s "Before starting the SDK"
gate's remaining item — operations hardening (section "1. Operations")
still hasn't happened. The gate's other item, an API-versioning decision,
was resolved 2026-08-23 via `/domain-modeling` — see ADR 0003 and the new
acceptance criterion below. Do not treat this ticket as unblocked until
operations hardening is actually done.

**Status:** ready-for-agent (do not pick up — see "Blocked by")

- [ ] The package is importable independently of the backend package
      (ticket 05) — never bundled with anything secret-key-scoped
- [ ] `signUp`, `signIn`, `signOut` correctly call through to the
      project-scoped endpoints from ticket 01, authenticated via the
      publishable key
- [ ] A reactive session hook correctly reflects the current end user's
      signed-in/signed-out state, including updating after `signOut`
- [ ] Errors surface the platform's existing `{ code, message }` shape
      directly
- [ ] Per ADR 0003: the SDK checks the `X-Kauth-Contract-Version` response
      header on every request and hard-fails on any exact mismatch with a
      clear message that the operation may already have completed
      server-side and must not be auto-retried
- [ ] No UI components are shipped — functions and the hook only
- [ ] Integration tests exercise the package against a real running test
      server, per the spec's single confirmed seam, including a
      version-mismatch test
