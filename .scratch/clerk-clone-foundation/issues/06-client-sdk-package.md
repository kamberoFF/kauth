# 06 — Client SDK package

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** A browser/mobile-safe SDK package, authenticated with a
project's publishable key, exposing headless sign-up, sign-in, sign-out
functions and a reactive session hook for the first supported framework —
proving a developer can wire kauth into their own UI without touching raw
HTTP or cookie handling directly.

**Blocked by:** 04

**Status:** ready-for-agent

- [ ] The package is importable independently of the backend package
      (ticket 05) — never bundled with anything secret-key-scoped
- [ ] `signUp`, `signIn`, `signOut` correctly call through to the
      project-scoped endpoints from ticket 01, authenticated via the
      publishable key
- [ ] A reactive session hook correctly reflects the current end user's
      signed-in/signed-out state, including updating after `signOut`
- [ ] Errors surface the platform's existing `{ code, message }` shape
      directly
- [ ] No UI components are shipped — functions and the hook only
- [ ] Integration tests exercise the package against a real running test
      server, per the spec's single confirmed seam
