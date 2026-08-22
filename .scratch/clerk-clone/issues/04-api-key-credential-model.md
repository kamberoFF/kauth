Type: grilling
Status: resolved
Blocked by: 02

## Question

How do downstream apps authenticate their SDK calls to kauth? (E.g. a
publishable/secret key pair like Clerk's, scoped per project, with rotation
and platform-level rate limits.) What does an API key actually authorize —
just SDK calls, or also the project's own admin/dashboard API?

> Note from ticket 03 (developer-facing auth bootstrap): kauth's own front
> door — no API key present, this *is* the dashboard — must resolve to the
> reserved platform Project by default, distinct from an API-key-scoped
> request registering an end-user into some Project X. Whatever
> request→project resolution mechanism this ticket settles on needs to
> satisfy that case explicitly.

## Answer

**Two key types, three authority tiers.** Not a flat "does an API key do
admin stuff or not" split — the secret key is genuinely elevated (Supabase's
`anon`/`service_role` framing), but "elevated" means *broad access to that
project's own end-user data*, not administration of the project as a
resource:

1. **Publishable key** (`pk_live_...`) — safe to ship in frontend/mobile
   code. Can only *start* things for that project's end users: sign-up,
   log-in, initiate an OAuth flow. No read/list/admin capability. Stored
   in plaintext (`key_value`) — it's meant to be public, and (per Clerk/
   Stripe UX) needs to stay re-viewable in the dashboard, not shown once.
2. **Secret key** (`sk_live_...`) — backend-only, elevated: full access to
   that project's own end-user data — verify a session server-side, list
   users, revoke any user's session, force-verify an email. This is what a
   downstream app's own backend uses to build things like "sign this user
   out everywhere" from its own admin panel. Stored **hashed only**
   (`key_hash`, same bcrypt-hash-never-plaintext idiom as
   `RefreshToken.token_hash`), shown once at creation, never retrievable
   again.
3. **Developer/platform session** (ticket 03) — governs the *project as a
   resource*: rename it, rotate its own keys, delete it, manage
   team/billing. Unreachable by any API key, of either tier — only a real
   login gets here. Directly answers the "front door" note above: kauth's
   own dashboard runs entirely on tier 3, never on a key.

### Schema

New model `ApiKey`: `id`, `project_id` (FK, indexed), `key_type` (enum
`PUBLISHABLE | SECRET`), `key_prefix` (first few chars kept in plaintext even
for secret keys, so the dashboard can show *which* key is which without
re-displaying the secret), `key_value` (plaintext, publishable keys only),
`key_hash` (secret keys only), `created_at`, `last_used_at`, `revoked_at`
(**revoked, never deleted** — same audit philosophy already established for
`Session`/`RefreshToken`), `created_by_user_id` (FK to the developer `User`
who created it, for audit — the key itself authorizes requests as *the
project*, not as that specific developer; it doesn't carry a `userId` into
request context the way a session does).

### Consequences

- **A new, parallel request-auth path.** Session-based auth (`requireAuth`,
  cookie/bearer JWT → `req.userId`/`req.sessionId`) and API-key-based auth
  (secret/publishable key → `req.projectId` + `req.apiKeyId`) are two
  distinct middleware paths, not one — a secret-key-authenticated request
  never resolves to a `userId`. This is what makes the platform-front-door
  constraint from ticket 03 concrete: kauth's own routes run
  `requireAuth`-only; project-scoped SDK routes run the key-based path.
- **New `SecurityEventType` values needed** eventually (`API_KEY_CREATED`,
  `API_KEY_REVOKED` at minimum) — same "every auth-relevant transition gets
  a SecurityEvent" rule the codebase already follows, not a new principle.
- **Rate limiting**: API-key-authenticated traffic gets its own limiter
  keyed on `apikey:${keyId}`, separate from the existing per-IP/per-account
  human-facing limiters — this is groundwork for, not a resolution of, the
  existing "platform-level rate limiting/abuse prevention" fog item.

### Explicitly deferred, not decided here

- **Test/live mode (sandboxed environments)** — parked as a new fog item, not
  designed this pass.
- **OAuth-per-project credentials** — already fog from ticket 02; unaffected
  by this ticket.

No code or schema files were modified — this records the design.
