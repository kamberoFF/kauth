# The role claim rides the token; the database decides

## Context

`Role` (`USER` | `ADMIN`) has sat on `User` since before the multi-tenancy
pivot, appearing in no token and gating nothing — the audits called RBAC
nominal. Enforcing it forces two decisions at once: what the role actually
authorizes, and where the authoritative value lives when a request checks it.

The second question has a trap. Putting a role in an access token invites
reading it back out during authorization, which reintroduces exactly the
staleness window this codebase has refused everywhere else: `requireAuth`
hits the database on every request precisely so that revocation is immediate,
and a cached session lookup is on record as deliberately not doing. A demoted
admin walking around with 15 minutes of stale `ADMIN` claim would be that
same bug wearing an authorization hat.

## Decision

Both halves are settled like this:

- **Scope**: `Role.ADMIN` means **platform staff** — an operator of the kauth
  instance, identified by holding ADMIN *inside the reserved platform
  Project* (the same vocabulary clerk-clone ticket 03 pinned). Staff gate a
  cross-tenant operator surface under `/admin/*` (list projects; list any
  project's users; view/revoke any session). Role alone, or platform Project
  membership alone, authorizes nothing.
- **Freshness**: every access token mints with a `role` claim read from the
  user row (register, login, OAuth exchange, MFA challenge completion, and
  each refresh rotation), but kauth never reads that claim back for
  authorization. The staff middleware trusts only the role `requireAuth` just
  selected from the same query it already runs. The claim exists for
  consumers, observability, and a future asymmetric-signing world where other
  services verify tokens offline — there it is understood to be advisory, as
  any embedded claim must be.

`verifyAccessToken` refuses payloads whose `role` is missing or outside the
enum: no deployment exists yet, so absence marks forgery rather than legacy.

## Alternatives considered

- **No claim at all** — rejected: the roadmap's complaint was "appears in no
  token", and consumers' backends legitimately want to see the role without
  another round-trip. The claim costs nothing because mint sites already hold
  the user row.
- **Authorizing from the claim** — rejected above: it converts a demotion
  into a 15-minute grace period nobody asked for.
- **Per-project tenant admins** (an app's end users governing each other) —
  deferred, not rejected: no consuming app has stated requirements, and
  designing roles-in-the-abstract risks guessing wrong (the library-pivot
  parking note). Revisit when one does.

## Consequences

- Demotion is immediate regardless of outstanding tokens; the stale claim on
  an old token is cosmetic until refresh re-mints it.
- The staff surface is session-only by construction: API keys authenticate as
  a Project, and the project inventory is exactly what a key must never see.
- Contract version bumps to 0.5.0 (new `/admin` routes; additive claim inside
  the token artifact).
