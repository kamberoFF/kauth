# 01 — Role claim in the JWT, DB-fresh staff gate, tracer route

Spec: `.scratch/rbac-enforcement/spec.md`

**What to build:** The `role` claim minted into every access token and the
`requirePlatformStaff` middleware that ignores it — authorizing from the
same per-request session read `requireAuth` already pays for — plus one
gated route (`GET /admin/projects`) proving the seam end-to-end, the
contract bump to 0.5.0 everywhere it is pinned, and ADR 0007.

**Status:** done

## Checklist

- [x] `types/jwt.ts`: `GenerateTokensParams` and `AccessTokenPayload` gain
      `role: "USER" | "ADMIN"`; `AccessToken` carries it too.
- [x] `lib/jwt.ts`: `generateTokens` signs the claim; `verifyAccessToken`
      refuses a payload whose role is missing or not one of the two enum
      values (pre-first-deployment: no legacy tokens exist to honor).
- [x] Every mint site passes a DB-fresh role: `createSession` gains a
      required `role` param (register, login, OAuth exchange, MFA challenge
      completion each pass their loaded user's role — OAuth's narrow select
      grows `role`); refresh re-mints via `storedToken.session.user.role`.
- [x] `middlewares/auth.ts`: the session query selects `user.role`; sets
      `req.userRole`. No new query on the hot path.
- [x] `middlewares/platformStaff.ts`: `requirePlatformStaff` — 403 code
      `staff_forbidden` unless `req.projectId === PLATFORM_PROJECT_ID` and
      `req.userRole === "ADMIN"`. Zero queries; composes after requireAuth.
- [x] `routes/admin.ts` mounted in `app.ts`: `GET /admin/projects` returns
      all projects (`id`, `name`, `ownerId`, `createdAt`) behind
      `requireAuth` + `requirePlatformStaff`. Session-only by construction.
- [x] Contract bump 0.4.0 → 0.5.0 in one commit-wide stroke:
      `backend/package.json` (drives `config.contract_version`), both SDKs'
      `package.json` + `src/version.ts` — keeps every commit green because
      the SDK suites run against the live header.
- [x] ADR 0007: "The role claim rides the token; the database decides" —
      scope (platform staff only), freshness invariant, revisit triggers.
- [x] Tests (`tests/rbac.test.ts`), abuse paths first, mutation-checked:
  - stale-claim demotion: token minted as ADMIN, user demoted directly in
    DB, old token still carries `role: ADMIN` yet `GET /admin/projects`
    answers 403 `staff_forbidden` (break the middleware's DB-read check and
    this test must fail);
  - USER in the platform Project → 403 `staff_forbidden`;
  - ADMIN in a non-platform Project → 403 `staff_forbidden`;
  - no token → 401; revoked session → 401;
  - forged token with no role claim → 401 (relax `verifyAccessToken` and
    this must fail);
  - staff lists projects including non-platform ones;
  - login/register/refresh bodies carry tokens whose decoded claim matches
    the actor's current role.

## Out of scope

Remaining staff routes, the role-change endpoint, the bootstrap script
(ticket 02); glossary/roadmap sync (ticket 03).
