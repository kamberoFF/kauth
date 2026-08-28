# Deferred-closeout batch — routing plan

> **Status:** planning stored 2026-08-26, nothing built yet. This file records
> decisions taken in conversation plus the skill workflow chosen to build them.
> Each epic gets its own grilling pass before tickets are written; this file is
> the map between them, not a spec.

## Locked decisions

Decisions made 2026-08-26 (grilling frontier cleared; details per epic still
open):

1. **Tenant admins get full project management** inside their own Project:
   user listing, session view/revoke, audit (SecurityEvent) reads, and Project
   settings & API-key management. Extends ADR 0007's staff surface inward;
   requirements stated by the operator (the consuming-app trigger ADR 0007
   waited for).
2. **Register drops auto-login** to close the duplicate-email identity oracle.
   Register returns success without tokens/session; clients call login after.
   Breaking register-contract change — explicitly re-decides the question
   frozen behind ADR 0003; contract version bumps accordingly and both SDKs
   learn the new flow.
3. **Mailer is integration-supplied**: `consoleMailer` becomes development-only
   (mirroring the production secret-length enforcement in `config.ts`);
   production refuses to start without an explicitly configured transport via
   `setMailer`. No stock SMTP provider ships with kauth.
4. **OAuth credentials stay deployer-supplied AND go per-Project.** Env-var
   Google/GitHub configuration remains the instance-level default (documented,
   wizard-covered), and each Project gains its own bring-your-own provider
   apps — the parked clerk-clone-map item. Design teeth to settle in grilling:
   credential encryption at rest (ADR 0006's `ENCRYPTION_KEY` pattern),
   redirect-URI strategy (providers require pre-registered URIs; `state` must
   carry the Project id), precedence over env providers, owner/admin management
   surface.

## Workflow

Three main-flow runs (`/grill-with-docs` → `/to-spec` → `/to-tickets` each),
one `/wizard`, then `/implement` per ticket with `/clear` between:

| Order | Epic | Tracker dir | Decisions | Notes |
| --- | --- | --- | --- | --- |
| 0 | ~~Tracker hygiene~~ | `.scratch/tracker-hygiene/` | — | Done 2026-08-26: ops-hardening issue 01 acceptance boxes ticked post-hoc |
| 1 | Register oracle + mailer posture | `.scratch/register-oracle/`, `.scratch/mailer-posture/` | 2, 3 | Smaller contracts pair; shares the contract-version question |
| — | Setup wizard | — | — | Generated after session 1 settles config story; walks through OAuth app creation, secrets generation, cleanup cron, staff promotion |
| 2 | Tenant RBAC + per-Project OAuth | `.scratch/tenant-rbac/`, `.scratch/project-oauth/` | 1, 4 | Management-surface pair; project-oauth needs its own ADR (encryption, redirect/state design, precedence) |
| 3 | Frontend auth flows | `.scratch/frontend-auth/` | — | Consumes sessions 1–2's final contracts via client-sdk; minimum scope: verify-email, reset-password, OAuth callback/exchange pages. Whether full login/register/MFA UI joins this epic is a session-3 grilling question |

Implementation order once tickets exist: mailer → register → tenant-rbac →
project-oauth → frontend-auth. Contract version lands as one 0.6.0 stroke or
sequential bumps — decided during session 1 under ADR 0003 discipline.

## Close-out duties

- Each epic ends with a docs-sync ticket updating `docs/roadmap.md` and
  README's status table (rbac-enforcement pattern).
- Roadmap intro points here until the batch ships.
