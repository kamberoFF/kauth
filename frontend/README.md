# kauth frontend

A scaffold. `src/App.tsx` is a placeholder — there is no auth client yet.

Vite + React 19 + TypeScript + Tailwind 4, with shadcn/ui configured
(`components.json`) but no components generated.

```bash
bun install
bun run dev      # http://localhost:5173
bun run lint
bun run build
```

## What it needs to become

The backend contract it will consume is documented in
[../backend/README.md](../backend/README.md). The parts that matter for a
browser client:

- **Cookies are the default transport.** Do not send `X-Token-Response: body`,
  and do not store tokens in `localStorage` — the backend is built so a browser
  never has to.
- **`GET /csrf-token` before the first unsafe request**, then echo the value in
  `X-CSRF-Token` on every `POST`. CSRF enforcement activates as soon as the
  session cookies exist.
- **Every auth request needs an `X-Device-Id` header** — a UUID the client
  generates and persists. It scopes sessions and logout to one device.
- **`/oauth/callback` needs a route.** The backend redirects the browser there
  with `?code=…`, which the client `POST`s to `/oauth/exchange` along with its
  device id to receive a session. `?error=…` arrives the same way on failure.
- **On a 401 with code `session_revoked` or `session_expired`, send the user to
  login** — refreshing will not help. `token_invalid` on an access token is
  worth one `POST /refresh` before giving up.
