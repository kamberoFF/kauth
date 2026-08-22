# 03 — Developer-facing auth bootstrap

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** One reserved, platform-owned Project exists (seeded at
startup/migration), and a developer can register and log in to it using the
exact same endpoints as any other project's end user — proving the platform
dogfoods its own auth rather than running a second stack. Project ownership
references a user within this reserved project.

**Blocked by:** 01

**Status:** done

- [x] The reserved platform Project exists after a fresh migration/seed,
      identifiable programmatically (e.g. a marker distinguishing it from
      ordinary projects)
- [x] A developer can register and log in through the same endpoints
      ticket 01 built, landing in the reserved project
- [x] The existing role field distinguishes an ordinary developer from
      platform staff within that project
- [x] A `Project` can be created with an owner reference to a user in the
      reserved project, and creation is rejected if the owner isn't a user
      of that project
- [x] Existing integration tests cover the bootstrap flow end-to-end
      (register a developer, log in, create a project they own)

## Comments

- 2026-08-22: `PLATFORM_PROJECT_ID` (fixed constant UUID, `constants/platform.ts`)
  + idempotent `ensurePlatformProject()` (`lib/platformProject.ts`), called at
  real startup (`server.ts`) and explicitly by tests. New `POST /projects`
  (`controllers/projects.ts`, `routes/projects.ts`) always sets
  `owner_id: req.userId` and 403s (`not_platform_developer`) unless the
  caller's session is scoped to the reserved project — no client-supplied
  owner id, matching every other self-service endpoint's pattern. Covered by
  `tests/projects.test.ts` (8 tests); the isolation-boundary test was
  mutation-checked (guard removed, confirmed the test fails, restored).
  Full suite: 138 pass / 0 fail.
