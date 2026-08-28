# Register drops auto-login

## Context

`POST /register` returned `201` with a token pair on a fresh email and
`409 { code: "duplicate_email" }` on one that already had an account. That
`409` is an identity oracle: any unauthenticated caller learns whether an
address is registered on the instance by reading a status code. It is the
last of the oracles the roadmap has been closing — login timing was closed
2026-08-24 — and it was left open then as **accepted residual risk**, because
closing it means register can no longer hand back a session: a duplicate-email
caller must get a response indistinguishable from a successful signup, and
that is a breaking change to the register contract, which ADR 0003 froze
behind `X-Kauth-Contract-Version`.

The roadmap recorded the exit condition: "Revisit only by explicitly
re-deciding that contract question." The deferred-closeout batch
(`.scratch/deferred-closeout/plan.md`) makes that re-decision.

`duplicate_username` is **not** part of the problem. Usernames are
user-chosen public handles; a collision on one discloses nothing about
anyone's email address.

## Decision

**`/register` returns a generic `202` with no session. Clients call `/login`
after.**

- Every well-formed register call that clears the username check and the
  password floor returns the same response — `202` with a single generic
  message, no tokens, no session, no user object, no device id, no MFA grace
  field. The happy path and the duplicate-email path are byte-identical
  (status, body, header set) and both do exactly one email round-trip and pay
  exactly one Argon2id hash, so response timing cannot separate them either.
- A fresh email creates the user and its credential account (no session),
  sends the confirmation link, and audits `USER_REGISTERED` with
  `sessionId: null`.
- An existing email creates nothing, audits a new server-side-only
  `REGISTER_DUPLICATE_EMAIL` event against the existing user, and sends that
  user a plain "someone tried to sign up with your address" notice carrying
  no token, no username, and no project name. It never emits
  `EMAIL_CONFIRMATION_SENT` — that event would itself be the oracle the
  response no longer is.
- **Device identity is now established only at `/login`.** `/register` runs no
  device resolution and issues no `kauth_device` cookie; a call with a
  missing or malformed device header succeeds.
- `duplicate_username` stays a `409`, checked and returned before any email
  handling.
- `POST /register` gains a per-account (project + email) rate limiter behind
  the existing per-IP one — mailbomb parity with the recovery endpoints.

This re-opens and re-decides the register contract ADR 0003 froze. The
contract version bumps to **0.6.0**; both SDKs redeploy in lockstep
(coordinated-redeploy event, ADR 0003).

## SDK impact

- `client-sdk`: `signUp(input): Promise<void>` — it calls `/register` and
  resolves; no state transition, the store stays `signedOut`, and the caller
  must call `signIn` next. A duplicate-email `signUp` resolves successfully
  (the server no longer returns `duplicate_email`, so the SDK cannot surface
  it); `signUp` still throws on `duplicate_username` and `validation`.
  `useSession().user` stays `null` after `signUp` — the field is kept for a
  future `/me`.
- `backend-sdk`: no API change (no register method) — version and
  `CONTRACT_VERSION` bump only.

## Alternatives considered

- **`signUp` auto-chaining to `signIn` inside the SDK** — rejected: a
  duplicate email with a *different* password would throw `auth_failed` on the
  chained call and reopen the very oracle this closes. The two-step flow is
  explicit.
- **Keeping the `409` but equalising timing** — rejected: the status code is
  the oracle, and no amount of timing work hides it.
- **A `/me` endpoint shipped alongside** to keep `useSession().user`
  populated after signup — deferred, not rejected. The `user` field stays on
  the session types for it; building it is later work.

## Consequences

- Breaking change: integrations that relied on register returning a session
  must add a `signIn` call. Weaker DX — no auto-login, and
  `useSession().user` is `null` until a `/me` endpoint exists.
- `signUp` can no longer surface `duplicate_email`; error handling that
  branched on it must drop that branch.
- Grace-window stamping for an MFA-mandated project now happens at first
  `/login` rather than at register.
- The registration oracle is closed; the roadmap's section 3 residual-risk
  note is paid down.
