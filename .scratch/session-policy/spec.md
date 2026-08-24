# Session Policy: server-issued device identity + sliding expiry

Source: `docs/roadmap.md`, section "4. Session policy". Decisions settled with
the user on 2026-08-24:

- Device ids are **server-issued**; the client never has to generate one.
  Delivery mirrors the existing dual token transport: an HttpOnly device
  cookie for browser clients (echoed automatically), plus a `deviceId` field
  in session-creating response bodies for programmatic clients. The
  `X-Device-Id` header survives only as an *echo channel* — the server value
  is authoritative and clients that already hold one keep working, which is
  what keeps "re-login replaces this device's old session"
  (`replaced_by_new_login`) meaningful for non-cookie clients.
- **Sliding expiry**: refresh slides `expires_at` forward (rolling window);
- **Inactivity timeout**: enforced in both `requireAuth` and refresh.

Tickets: `issues/01-server-issued-device-identity.md`,
`issues/02-sliding-expiry-and-inactivity-timeout.md`.
