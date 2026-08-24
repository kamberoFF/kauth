# 06 — Client SDK package

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** A browser/mobile-safe SDK package, authenticated with a
project's publishable key, exposing headless sign-up, sign-in, sign-out
functions and a reactive session hook for the first supported framework —
proving a developer can wire kauth into their own UI without touching raw
HTTP or cookie handling directly.

**Blocked by:** 04 (done). The roadmap "Before starting the SDK" gate's last
open item — operations hardening — was satisfied 2026-08-24 by the
`ops-hardening` tickets; see `docs/roadmap.md`.

**Status:** done

- [x] The package is importable independently of the backend package
      (ticket 05) — never bundled with anything secret-key-scoped
- [x] `signUp`, `signIn`, `signOut` correctly call through to the
      project-scoped endpoints from ticket 01, authenticated via the
      publishable key
- [x] A reactive session hook correctly reflects the current end user's
      signed-in/signed-out state, including updating after `signOut`
- [x] Errors surface the platform's existing `{ code, message }` shape
      directly
- [x] Per ADR 0003: the SDK checks the `X-Kauth-Contract-Version` response
      header on every request and hard-fails on any exact mismatch with a
      clear message that the operation may already have completed
      server-side and must not be auto-retried
- [x] No UI components are shipped — functions and the hook only
- [x] Integration tests exercise the package against a real running test
      server, per the spec's single confirmed seam, including a
      version-mismatch test

## Answer

Shipped as `packages/client-sdk` (`@kauth/client-sdk`, 0.1.0): framework-
agnostic core at the root export (`createKauthClient` → `signUp`, `signIn`,
`signOut`, plus a tiny observable store: `getSnapshot`/`subscribe`) and the
React binding at `@kauth/client-sdk/react` (`useSession`, a thin
`useSyncExternalStore` wrapper). No shared code with the backend package —
the errors/version modules are deliberately duplicated so neither package can
drag the other into its bundle. React is an optional peer dependency.

Transport: body tokens via `x-token-response: body` (the platform's explicit
native-client opt-in), since the client must work identically in browsers and
native apps; the host app decides what to persist. Device id defaults to a
per-instance UUID, overridable for persistence across restarts.

Known gap surfaced during design: `/login` returns tokens without a profile,
so a session created by `signIn` carries `user: null` (documented in the API
docs). A future `/me` endpoint would close that; out of scope here.

Tests in `backend/tests/clientSdk.test.ts`: 14 integration tests against the
running test server — sign-up scoping + DB state, token acceptance,
duplicate_email/auth_failed surfacing, sign-out server-side revocation,
reactive transitions, version mismatch including mutating-call-completes-
anyway. Mutation-checked both the contract-version guard and the sign-out
network call — each fails with its control broken. Lockstep guard extended:
`contractVersion.test.ts` now holds server, backend-sdk, and client-sdk
versions together.

Code-review follow-ups: `useSession` is exercised through React's own
renderer (via a dev-only probe module inside the package, not exported), not
just smoke-imported; that surfaced a real fix — the hook now passes its
snapshot as `getServerSnapshot`, so server rendering works instead of
throwing. A version-mismatched `signOut` is deliberately untested: a stale
client can never hold local session state (its own auth calls reject first),
so signOut always no-ops before reaching the wire; noted in the test file.

`bun test`: 231 pass, 0 fail. Typecheck and lint clean.
