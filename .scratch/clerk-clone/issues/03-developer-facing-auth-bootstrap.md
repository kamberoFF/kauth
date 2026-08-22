Type: grilling
Status: resolved
Blocked by: 02

## Question

The developers who register projects and manage API keys need to log into
*something* themselves. Does kauth dogfood its own auth stack for this "meta"
layer (kauth-the-platform's own operator/developer accounts), or is
developer-facing auth a separate, simpler system?

## Answer

**Dogfood kauth itself.** Developer/operator accounts are ordinary `User`
rows living in one reserved, platform-owned `Project` — using the exact same
`Session`/`RefreshToken`/`SecurityEvent` machinery designed in ticket 02, not
a second auth stack. `Project.owner_id` then just points at a `User` whose
`project_id` is that reserved Project.

### Consequences of this choice

- **`Role` already does the work.** No new field needed: within the reserved
  platform Project, `Role.USER` means an ordinary developer who's signed up
  to create/manage their own Projects, and `Role.ADMIN` means platform staff.
  Same enum, same column, already on `User`.
- **The reserved Project needs to exist before the first developer can
  register** — a one-time seed at deploy time (fixed id or an `is_platform`
  marker), not a new registration code path. `owner_id` referencing a `User`
  whose `project_id` is that platform Project is an app-level invariant
  (Prisma can't declare a cross-field constraint like that); worth a
  `CHECK`/trigger later if it needs DB-level enforcement, but not required to
  record this decision.
- **This directly simplifies ticket 04.** The developer dashboard's own
  sessions look exactly like any end-user's session, just scoped to the
  platform Project — API-key management endpoints gate on
  `session.project_id === PLATFORM_PROJECT_ID` (+ role, where relevant)
  through the same `requireAuth`, not new middleware.
- **A real constraint for ticket 04**: kauth's own front door (no API key
  present — this *is* the dashboard) must resolve to the reserved platform
  Project by default, distinct from an API-key-scoped request registering an
  end-user into some Project X. Noted on ticket 04 directly.

### Explicitly deferred, not decided here

- **Team/multi-developer ownership of one Project** (can two developers
  co-manage the same Project, the way Vercel/Stripe team seats work?) — not
  asked by this ticket's question; added as a new fog item.
