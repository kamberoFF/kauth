# 04 — Docs-sync: roadmap, route inventory, READMEs

Status: done (folded into ticket 03's commit)

**What to build:** the living docs describe the Project owner management
surface as shipped.

- `docs/roadmap.md` — the RBAC-enforcement section (or the intro's "Next up"
  list) records that a Project owner now has a session-authenticated
  management surface over their own Project (users list, session
  list/inspect/revoke, security-event reads), that the two new reads are also
  on the secret-key surface, and that **no tenant-admin role was introduced**
  — `Role.ADMIN` still gates nothing in a tenant Project, ADR 0007 stands.
  Contract version stated as `0.7.0` where the roadmap tracks it (note it is
  the shared epic-2 bump; `project-oauth` rides the same number).
  `Last reviewed:` bumped.
- `CLAUDE.md` — the `routes/` inventory line, if it enumerates routes, gains
  the owner management routes and the two new `/project/*` routes.
- `backend/README.md` and the SDK READMEs — any status table or prose that
  names the contract version, or that lists the secret-key / owner surface,
  is updated; `backend-sdk` README documents `listEvents()` / `listSessions()`.
- Standard epic close-out per `.scratch/deferred-closeout/plan.md`; may fold
  into ticket 03's merge if they land together — implementer's call.

**Blocked by:** 03

- [x] `docs/roadmap.md` describes the owner management surface as shipped and explicitly states no tenant-admin role was added — new "Update 2026-08-29" block in the RBAC-enforcement section, plus the intro paragraph
- [x] The roadmap's contract version reads `0.7.0` where tracked (stated as the shared epic-2 bump)
- [x] `Last reviewed:` already `2026-08-29` (bumped by an earlier same-day edit); unchanged
- [x] `CLAUDE.md` route inventory — n/a; the Layout section calls `routes/` "thin" and does not enumerate routes
- [x] SDK READMEs: `backend-sdk` README documents `listSessions()` / `listEvents()` and drops the stale one-line capability summary. `backend/README.md` names no contract version and its API tables never covered the `/project/*` or owner surface (neither did tickets 01–02), so no stale text to fix.
