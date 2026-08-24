# Encrypting MFA secrets at rest under a dedicated ENCRYPTION_KEY

## Context

A TOTP shared secret must survive process restarts — an authenticator app
stays enrolled across deploys — so unlike refresh tokens or recovery tokens,
which only need their hashes, this one has to be recoverable. That rules out
the hash-only posture every other long-lived credential in kauth uses, and
forces a decision about how the secret sits in the database: a `users`
column that a `SELECT *` away from any SQL injection or backup leak.

## Decision

The TOTP secret is stored AES-256-GCM-encrypted (`backend/lib/cryptoBox.ts`)
under a new **required** env var, `ENCRYPTION_KEY`. The actual AES key is
derived via SHA-256 over (`ENCRYPTION_KEY` ‖ `"kauth:mfa-totp"`), so the
namespace label — not the raw key — scopes each use, and a future encrypted
column can derive its own subkey without ever sharing this one. Payloads are
base64(`iv ‖ tag ‖ ciphertext`) with a fresh random IV per call; GCM's auth
tag makes any tamper throw on decrypt rather than return attacker-mangled
bytes that would desynchronize an authenticator.

`ENCRYPTION_KEY` fails startup fast through the same zod gate as
`JWT_SECRET`/`COOKIE_SECRET`, with one stricter rule: it must decode (hex or
base64) to at least 32 real bytes of entropy, wherever configured — not just
in production. A weak "encryption" key is worse than none, because it reads
as protection while providing almost none.

## Alternatives considered

- **Plaintext column** — rejected outright: it puts working second-factor
  material one backup leak away from an attacker who already has password
  hashes, quietly doubling the value of that leak.
- **Derive from `JWT_SECRET`** — rejected: it couples rotation of unrelated
  secrets (rotating a signing key would silently brick every enrollment),
  and JWT_SECRET compromise would then also decrypt MFA secrets — two
  unrelated failures collapsing into one blast radius.
- **External KMS / secrets manager** — out of scope: kauth is self-hosted by
  design (ADR 0005's minimal-infrastructure spirit); requiring cloud KMS
  would price out exactly the operators it serves.

## Consequences

- Operators gain a third required secret. Greenfield, no deployments exist,
  so this breaks nobody today; it rides the same 0.4.0 contract wave.
- Losing `ENCRYPTION_KEY` loses all enrollments (users re-enroll; no data
  beyond the secret is lost). That is the recoverable-failure direction to
  err on: an unreadable secret disables itself instead of authenticating.
- The derivation namespace (`kauth:mfa-totp`) reserves room for other
  encrypted-at-rest consumers without another env var each.
