# RBAC enforcement: platform-staff surface with a ride-along role claim

Source: `docs/roadmap.md`, "Features" (second open bullet). Scope settled with
kambe on 2026-08-26. The audit finding this closes: "`Role` exists on the
user, appears in no token, and gates nothing."

## Decisions

- **What ADMIN gates: the platform-staff surface, nothing else.** Within the
  reserved platform Project (`clerk-clone` ticket 03's recorded vocabulary),
  `Role.ADMIN` means platform staff. Staff get operator routes over all
  tenants — list projects, list any project's users, view and revoke any
  session — mirroring what a secret key can do inside one project, but
  cross-project and session-authenticated. Per-project tenant admins (an
  app's own end users governing each other) are **deliberately not built**:
  no consuming app has asked, and `library-pivot`'s parking note ("designing
  it in the abstract risks guessing wrong") still holds for that half.
  Revisit when a real consuming app names its requirements.
- **The claim rides the token; the database decides.** Access tokens carry a
  `role` claim from every mint site (register, login, OAuth exchange, MFA
  challenge completion, refresh rotation), so consumers can *see* the role
  and future asymmetric verification has something to verify. But
  authorization never reads the claim: `requireAuth` already selects the
  user row on every request, so it now also selects `role`, and the staff
  gate checks that DB-fresh value. A demoted admin's old token keeps its
  stale `ADMIN` claim for up to 15 minutes with zero security effect. This
  is ADR 0007.
- **Roles are changed by staff, within the platform Project only.**
  `POST /admin/users/:userId/role` settable only by staff, targeting only
  platform-Project users; changing an end user's role in some tenant Project
  is nobody's job yet. Self-change is refused (403) so a lone staff member
  cannot accidentally lock every operator out; recovery from a lost staff
  team is the bootstrap script, not a special case in the endpoint.
- **Bootstrap is a script plus a staff endpoint.** Nothing sets roles today,
  so the first admin cannot come from HTTP alone. An idempotent
  `scripts/promoteStaff.ts` promotes an existing platform-Project user by
  email at deploy time; after that, staff promote further staff over the API.

## Non-goals

- No per-project tenant-admin gating, no permission granularity beyond the
  two enum values, no role in refresh tokens (they are opaque by design).
- The staff surface is session-only: API keys authenticate as a Project, and
  "which projects exist" is precisely what a key must never see.

## Tickets

1. `01-role-claim-and-platform-staff-gate.md` — claim plumbing end-to-end,
   DB-fresh staff gate, tracer-bullet route `GET /admin/projects`, contract
   bump to 0.5.0 across server and both SDKs, ADR 0007.
2. `02-staff-surface-and-role-management.md` — remaining staff routes,
   role-change endpoint, `ROLE_CHANGED` event, bootstrap script.
3. `03-docs-sync.md` — glossary, roadmap, README truthfulness pass.
