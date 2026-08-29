# @kauth/backend-sdk

Server-only client for a [kauth](../../README.md) instance, authenticated
with a project's **secret** key. Verify sessions against the platform's own
database in real time, list the project's users and sessions, read its
security-event log, revoke sessions. Never ship this package (or the key) to a
browser.

```ts
import { createKauthBackend } from "@kauth/backend-sdk";

const kauth = createKauthBackend({
  baseUrl: "https://auth.example.com",
  secretKey: process.env.KAUTH_SECRET_KEY!,
});

// Every call is live: a session revoked moments ago reads as inactive here.
const session = await kauth.verifySession(sessionIdFromRequest);

const users = await kauth.listUsers();
await kauth.revokeSession(sessionId);
```

Errors throw as `KauthError` carrying the platform's code (`session_inactive`,
`session_not_found`, `unknown_error`, …).

## Listing sessions and events

`listSessions()` and `listEvents()` read the calling project's own data,
reverse-chronological and cursor-paginated. Each returns a
`Page<T>` = `{ items, nextCursor }`; pass `nextCursor` back as `cursor` to
walk subsequent pages (`nextCursor` is `null` on the last page).

```ts
// Every ACTIVE session in the project, or just one user's.
const page = await kauth.listSessions({ limit: 100 });
const forUser = await kauth.listSessions({ userId });

// The project's security-event log, filterable by type and user.
let cursor: string | undefined;
do {
  const events = await kauth.listEvents({
    eventType: ["LOGIN_FAILED", "MFA_DISABLED"],
    cursor,
  });
  ship(events.items);
  cursor = events.nextCursor ?? undefined;
} while (cursor);
```

`listUsers()` stays non-paginated — its underlying route is unchanged.

## Project settings

Owner-settable project settings — password floor, MFA mandate, grace window
— are changed through `PATCH /projects/:projectId`, which is
**session-authenticated** and deliberately never reachable by a secret key.
This package therefore ships no settings call, only the contract type, so
admin tooling and owner-session flows can share it:

```ts
import type { UpdateProjectSettingsInput } from "@kauth/backend-sdk";

const patch: UpdateProjectSettingsInput = {
  enforce_mfa: true,
  // Grace window for unenrolled users, in days. Accepted only within 3–90:
  // anything outside is rejected with `validation` rather than silently
  // adjusted, because a quietly shortened or lengthened lockout window is a
  // policy decision an owner should have to state correctly. Null (or
  // omitting the field once the mandate is on) means the deployment default
  // of 7 days.
  mfa_grace_days: 14,
};
```

Partial-update semantics: an absent field is left untouched; an explicit
`null` clears back to the deployment default (`PASSWORD_MIN_LENGTH` for the
password floor, 7 days for the grace window). Turning `enforce_mfa` on
grants every currently-unenrolled user their grace window immediately;
each user's deadline is stamped at their next sign-in if they don't have
one yet.

## Contract versioning

Every request is stamped against the contract version this SDK was built
with (`CONTRACT_VERSION`) and hard-fails on any mismatch with the server's
`X-Kauth-Contract-Version` header — see ADR 0003. A mismatch means the
operation may already have completed server-side; do not auto-retry.
