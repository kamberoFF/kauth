# 02 — Staff surface routes, role management, bootstrap script

Spec: `.scratch/rbac-enforcement/spec.md`

**What to build:** The rest of the operator surface behind the ticket-01
gate, the staff-only role-change endpoint (platform-Project targets only),
the `ROLE_CHANGED` audit event, and `scripts/promote-staff.ts` so the first
admin can exist without HTTP chicken-and-egg.

**Status:** ready-for-agent

## Checklist

- [ ] `GET /admin/projects/:projectId/users` — any project's users, same
      shape `listProjectUsers` already returns (id, email, username,
      emailVerified, role, createdAt); unknown project → 404
      `project_not_found`.
- [ ] `GET /admin/sessions/:sessionId` — view any session cross-project;
      unknown id → 404 `session_not_found`.
- [ ] `DELETE /admin/sessions/:sessionId` — revoke any ACTIVE session;
      adds `"staff_revoked"` to `RevocationReason`; writes SESSION_REVOKED
      with metadata `{ actor_user_id }` inside the caller's transaction.
      Revoking an already-revoked session → 404, matching the secret-key
      route's active-only filter.
- [ ] `POST /admin/users/:userId/role` body `{ role: "USER" | "ADMIN" }` —
      platform-Project users only (otherwise 404 `user_not_found`);
      self-change → 403 `self_role_change`; zod enum validation → 400.
      Writes ROLE_CHANGED (severity derived: WARNING) with metadata
      `{ old_role, new_role, actor_user_id }` in the same transaction as
      the update. Takes effect on the victim's next request — no token
      invalidation needed, because authorization is DB-fresh (ADR 0007).
- [ ] New SecurityEventType `ROLE_CHANGED` + severity map entry.
- [ ] `scripts/promote-staff.ts` — `bun scripts/promote-staff.ts
      --email <addr>` promotes an existing platform-Project user to ADMIN;
      exits non-zero with a clear message when absent; idempotent on
      re-run. Thin wrapper over Prisma; no new env knobs.
- [ ] Tests (`tests/adminSurface.test.ts`), abuse paths first:
  - every staff route refuses a plain USER, a non-platform ADMIN, and an
    API key (any tier) with the appropriate 401/403;
  - cross-project view/revoke works where the secret-key route would 404;
  - revoked victim's next authenticated request fails; event row written
    with actor attribution and no secrets in metadata;
  - role grant/demote round-trip: promoted USER reaches `/admin/projects`
    on their *existing* session without re-login (the DB-fresh property);
  - self-change refused; tenant-Project target 404; bad role 400;
    ROLE_CHANGED rows recorded;
  - script: happy path, unknown email non-zero exit, re-run idempotent.

## Out of scope

Docs/glossary sync (ticket 03). No rate limiter beyond the global one —
staff routes are authenticated, low-volume, operator-facing.
