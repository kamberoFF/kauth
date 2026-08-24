# 01 — Server-issued device identity

Spec: `.scratch/session-policy/spec.md`

**What to build:** The server, not the client, guarantees the device id. A
client that supplies no device context gets one minted; a client echoing a
previously issued value keeps working. No code path requires the client to
have generated a UUID anymore.

**Blocked by:** None - can start immediately
**Status:** done

## Behavior

- **Creation endpoints (`/register`, `/login`):** replace `requireDevice`
  with resolution: device cookie → `X-Device-Id` header → mint
  `crypto.randomUUID()`. A malformed supplied value is still
  `400 device_id_invalid`; an absent one is never an error.
- **Echo endpoints (`/refresh`, `/logout`, `/oauth/exchange`):** same
  resolution order (cookie first), but absence of both remains
  `400 device_id_missing` — refresh must stay bound to the presenting
  context.
- **Responses that create a session:** set an HttpOnly `kauth_device` cookie
  (path `/`, SameSite Lax, long maxAge — it identifies the browser profile,
  not the session) and include `deviceId` in the JSON body unconditionally,
  so non-cookie clients can persist and echo it.
- **Logout:** clears the device cookie along with the auth cookies.
- **client-sdk:** stops pre-generating `crypto.randomUUID()`; captures
  `deviceId` from sign-up/sign-in responses and echoes it thereafter.
- Contract version moves with this release per ADR 0003 if the lockstep
  guard requires it.

## Acceptance criteria

- [x] Register/login with no device context succeed; response body carries
      the minted `deviceId`, a `kauth_device` cookie is set, and the session
      row stores exactly that value.
- [x] Register/login with a malformed `X-Device-Id` still return
      `device_id_invalid`.
- [x] Refresh/logout/exchange with neither cookie nor header still return
      `device_id_missing`; a valid echo (either channel) works; a mismatched
      echo on refresh still fails with `device_mismatch`.
- [x] A browser-style cookie client can register, refresh, and log out
      without ever sending `X-Device-Id`.
- [x] Logout clears `kauth_device`.
- [x] client-sdk tests updated for capture-and-echo behavior.
- [x] typecheck, lint, and the full integration suite pass.
