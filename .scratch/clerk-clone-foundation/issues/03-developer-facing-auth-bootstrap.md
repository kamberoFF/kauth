# 03 — Developer-facing auth bootstrap

Spec: `.scratch/clerk-clone/spec.md`

**What to build:** One reserved, platform-owned Project exists (seeded at
startup/migration), and a developer can register and log in to it using the
exact same endpoints as any other project's end user — proving the platform
dogfoods its own auth rather than running a second stack. Project ownership
references a user within this reserved project.

**Blocked by:** 01

**Status:** ready-for-agent

- [ ] The reserved platform Project exists after a fresh migration/seed,
      identifiable programmatically (e.g. a marker distinguishing it from
      ordinary projects)
- [ ] A developer can register and log in through the same endpoints
      ticket 01 built, landing in the reserved project
- [ ] The existing role field distinguishes an ordinary developer from
      platform staff within that project
- [ ] A `Project` can be created with an owner reference to a user in the
      reserved project, and creation is rejected if the owner isn't a user
      of that project
- [ ] Existing integration tests cover the bootstrap flow end-to-end
      (register a developer, log in, create a project they own)
