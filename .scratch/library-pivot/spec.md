Status: superseded — reconciled into the clerk-clone platform direction
(2026-08-21); see `.scratch/clerk-clone/map.md`

# kauth SDK: the client layer for the hosted platform

Originally captured from a `/grilling` session on 2026-08-15 as an exploration
of pivoting kauth from a standalone service into an embeddable library. On
2026-08-21 the user settled kauth's actual direction as a self-hosted,
self-serve, multi-tenant Clerk/WorkOS clone (see the wayfinder map at
`.scratch/clerk-clone/map.md`) — **the hosted service is not going away.**
This document is kept as history. The "What changed" section below is the
reconciliation this file exists to record; everything under "Original capture"
is the original 2026-08-15 discussion, left intact except for inline notes
marking the parts the platform direction overrides.

## What changed

- **The hosted service stays.** kauth is not being deleted or replaced by an
  embedded library. `backend/` becomes the multi-tenant platform other apps
  talk to over the network — the opposite of "deleted outright" below.
- **"Library" now means SDK, not embeddable engine.** The client piece a
  downstream app installs is a thin SDK that calls the hosted kauth API
  (sign-up/sign-in/session helpers, comparable to Clerk's client SDKs) — not
  the auth engine itself running in the consumer's own process against the
  consumer's own database. The "installed into a consumer's own app process,
  using the consumer's own database connection" framing under Product
  identity below is superseded.
- **Self-service becomes API surface, not library functions.** Where the
  original scope said "library functions, not HTTP routes" for session
  listing/revocation and linked-provider management, the platform direction
  inverts this: these are hosted API endpoints the SDK wraps in convenient
  methods, since the SDK runs in a separate process/app from kauth itself.
- **The "not completely sure" open thread is resolved.** The user confirmed
  the direction on 2026-08-21; this is no longer speculative.

The reconciled design questions (SDK shape, API surface, per-tenant
authentication) are tracked as wayfinder tickets, not decided here — see
`.scratch/clerk-clone/issues/05-sdk-client-library-shape.md` (SDK shape) and
`.scratch/clerk-clone/issues/04-api-key-credential-model.md` (how the SDK
authenticates to the hosted API).

## Original capture (2026-08-15) — kept for history

Captured from a `/grilling` session on 2026-08-15. This is a **shared
understanding reached through discussion, not a decision to act on yet** — the
user is still not completely sure this is what they want. Do not start
implementation from this file alone; confirm intent again before acting on it.

> Superseded 2026-08-21 — see "What changed" above.

### Product identity

- Pivots from a standalone deployable auth *service* to an open-source auth
  *library* — installed into a consumer's own app process, using the
  consumer's own database connection. Name stays "kauth."
- Stack-specific for now: Bun + Express + Prisma + Postgres. Framework/database
  agnosticism is a stated long-term goal, not built today — extension seams
  stay internally decoupled but *not* formalized as public adapter interfaces
  until carved out (see below — this repo's split is an exception, done
  deliberately early).

### Repo structure — monorepo, split now

> Superseded 2026-08-21 — the embed-in-your-process model this section
> describes does not apply to a hosted multi-tenant platform. Kept for
> history; the actual SDK/repo shape is an open wayfinder question (ticket
> 05), not this.

- `packages/core` — the auth logic itself, plus the adapter-interface
  contracts the other packages implement.
- `packages/adapter-express` — carved out now, despite only one framework
  being targeted (deliberate call, not deferred — overrides the
  "wait for a real second case" default because the user chose to).
- `packages/adapter-prisma` — same treatment, carved out now for consistency
  with the Express decision.
- `apps/example` — a fresh reference/demo app that mounts the library
  end-to-end; doubles as the integration-test harness. Built from scratch —
  the current `backend/` Express/Docker service code is **deleted outright**,
  not migrated (explicit choice over reusing it via `git mv`; git history
  still has it if that turns out to be wrong).

### Sequencing

- The existing `docs/roadmap.md` order is unchanged: Operations hardening →
  Argon2id → identity-oracle fixes → session policy (server-issued device id,
  sliding expiry) → multi-instance readiness, *before* new feature work. The
  pivot changes the destination, not the order of getting the foundation
  solid first. **Still true under the platform direction** — reconfirmed
  2026-08-21, see the clerk-clone map's Notes.
- No backward-compatibility constraint — schema and API are free to redesign;
  nothing currently depends on the current shape (frontend has no auth client
  yet). **Still true** — reconfirmed 2026-08-21 (greenfield).

### Feature scope — "the standard suite done right"

- Credentials + OAuth sign-in: already solid, carries forward as-is.
- MFA: TOTP only for this pass; passkeys/other factors are a later, separate
  unit of work, not bundled with TOTP.
- RBAC enforcement: parked — the `Role` column on `User` stays unused until a
  real consuming app's requirements inform the shape. Designing it in the
  abstract risks guessing wrong.
- Self-service, exposed as library functions (not fixed HTTP routes):
  > Superseded 2026-08-21 — see "What changed" above: these become hosted API
  > endpoints the SDK wraps, not in-process library functions.
  - Session listing/revocation — in scope.
  - Linked-provider listing/unlinking — in scope.
  - Email-change — **deferred**. Reopens the identity-oracle problem already
    open on the roadmap (verifying a new address on a live account has the
    same enumeration-risk shape as registration).
  - Account-deletion — **deferred**. Needs a real decision on how it
    interacts with `SecurityEvent` rows that reference the user (audit-log
    integrity vs. actually deleting data) — not decided yet.

### Schema extensibility

- Consumer-added fields relate via a foreign key to kauth's own tables (e.g. a
  `Profile` table referencing `User.id`) — ships now, needs no new mechanism,
  matches the existing aggregate-boundary principle (kauth's `User` stays
  kauth's aggregate; the app's own domain data is the app's own). **Still
  plausible under the platform direction** — likely even more natural now,
  since every consumer app already has its own DB and process; worth
  revisiting once the multi-tenant data model (ticket 02) is settled.
- Merged/flat-table field composition (better-auth-style `additionalFields`,
  one physical table instead of a join) stays a **later possibility**, not
  designed or built yet — would need real schema-composition tooling
  (codegen or Prisma's multi-file schema composition) as its own design pass.

### Open threads not yet resolved

- ~~The user explicitly said, at the end of this session, that they are not
  completely sure this is what they want for the project.~~ **Resolved
  2026-08-21** — direction confirmed as the multi-tenant Clerk/WorkOS clone.
- License and package-publishing details (npm/JSR, registry, versioning
  scheme) were not discussed — left as trivial/administrative, not a design
  branch, but still genuinely undecided. **Still open** — relevant to the SDK
  ticket (05) once it's reached.
- Whether `docs/roadmap.md` and `README.md` get rewritten to reflect this (if
  it's confirmed) hasn't been discussed. **Still open** — the clerk-clone
  map's Notes say the roadmap's "not an identity provider" line gets
  struck/rewritten once the map's spec lands, not before.
