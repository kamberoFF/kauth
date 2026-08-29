# 05 — Closeout: ADR 0009 + client-sdk + docs-sync

Status: ready-for-agent

**What to build:** the decision record and the living docs describe
per-Project OAuth as shipped.

- **`docs/adr/0009-per-project-oauth-credentials.md`** — a draft was written
  during the grilling session. Reconcile every detail against what actually
  shipped across tickets 01–04 (the encryption namespace label, the
  signed-`state` shape, the enum/mode names, the endpoint paths) and commit
  it as the accepted ADR. It must record: the `kauth:project-oauth`
  encryption namespace and the `kauth:oauth-state` HMAC namespace; the single
  callback URL + signed-`state` Project binding + removal of
  `kauth_oauth_project`; the inherit / override / disable precedence; and the
  rejected alternatives — a shared kauth-branded OAuth broker, per-Project
  callback paths, and a decrypted-provider-client cache.
- **`client-sdk`** — if it calls `GET /oauth/providers`, add the `projectId`
  query param (it holds the publishable key's Project). If it does not, no
  code change — note that in the ticket.
- **Docs-sync** — `docs/roadmap.md` (per-Project OAuth shipped; ADR 0009 in
  the list; the instance env config is now an inheritable default),
  `backend/README.md` + `.env.example` (instance Google/GitHub config is a
  default, per-Project Provider apps exist), the ADR index, and a verify pass
  that `CONTEXT.md`'s **Provider app** entry matches what shipped.
- Standard epic close-out per `.scratch/deferred-closeout/plan.md`. **This
  completes batch epic 2** — the plan's epic-2 row and the roadmap intro
  should reflect that (tenant-rbac + project-oauth both done, contract at
  `0.7.0`).

**Blocked by:** 04

- [ ] `docs/adr/0009-per-project-oauth-credentials.md` matches the shipped implementation and is committed as accepted
- [ ] `client-sdk` either passes `projectId` to `/oauth/providers` or the ticket records that it does not call that endpoint
- [ ] `docs/roadmap.md` describes per-Project OAuth as shipped, lists ADR 0009, and marks batch epic 2 complete with the contract at `0.7.0`
- [ ] `backend/README.md` / `.env.example` describe the instance OAuth config as an inheritable default and mention per-Project Provider apps
- [ ] `CONTEXT.md`'s **Provider app** entry is consistent with what shipped
- [ ] `bun test`, `bun run typecheck`, `bun run lint` all green
