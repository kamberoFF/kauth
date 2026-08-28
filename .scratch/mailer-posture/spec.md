Status: ready-for-agent

# kauth Mailer Posture — integration-supplied transport, production fail-fast

Collapsed from the deferred-closeout batch's session-1 grilling
(`/grill-with-docs`, frontier cleared over three rounds, 2026-08-28). The
settled design lives in `.scratch/deferred-closeout/plan.md` under "Session 1
grilling outcome → Mailer posture (ships first — no contract impact)"; this
spec is the buildable synthesis. This is the **first** epic-1 ticket set and
carries **no contract-version impact** — it lands before the register-oracle
work.

## Problem Statement

kauth ships no mail transport. `lib/mail.ts` defaults to `consoleMailer`,
which prints the message body (verification links, reset tokens) to stdout,
and a deployment is expected to call `setMailer` at startup with its own
transport. Nothing enforces that expectation:

- A production instance that forgets to wire a transport boots happily and
  silently prints every verification link and password-reset token to its
  logs — the exact "never put tokens in logs" rule the rest of the codebase
  is careful about, defeated by a missing one-liner.
- `config.ts` already enforces this class of "a real deployment cannot start
  with an unsafe default" for `JWT_SECRET` / `COOKIE_SECRET` (length) and
  `ENCRYPTION_KEY` (entropy). The mailer is the conspicuous gap.
- The operator has no declarative way to point kauth at a transport module —
  `setMailer` is a code call, so the only integration path today is editing
  `server.ts` or writing a wrapper entrypoint.
- The setup wizard's email-verification stage warns "turning this on before a
  real transport exists locks every user out" but has no way to check whether
  a transport is actually configured, so it can only nag.

## Solution

kauth gains a declarative transport hook and refuses to run in production
without one:

- A new optional `MAILER_MODULE` env var names a module to load at startup.
  kauth dynamically imports it, accepts a `Mailer` from its `default` or
  named `mailer` export, and installs it via `setMailer` before anything else
  in `main()` runs — in particular before migrations.
- In production, if no transport is configured after that load step, kauth
  throws and exits non-zero, the same fail-fast posture as an unsafe secret.
- In development and test, `consoleMailer` stays the default. The first time
  a mail is actually sent through the console transport, kauth logs a
  one-time `warn` so the "this is not a real transport" fact is visible
  without being noisy.
- `MAILER_MODULE` is still an operator-supplied module — kauth does not ship
  an SMTP client or pick a provider. The README and `.env.example` document
  the export contract; the setup wizard prompts for the path and uses its
  presence to decide whether enabling `REQUIRE_EMAIL_VERIFICATION` is safe.

No ADR — this enforces an already-stated posture (the plan's locked decision
3), it does not decide a new one. Roadmap note only.

## User Stories

1. As an operator deploying kauth to production, I want the server to refuse
   to start when no mail transport is configured, so that I cannot
   accidentally ship an instance that prints verification links and reset
   tokens to its logs.
2. As an operator, I want to name my transport module in an env var rather
   than editing `server.ts`, so that my integration is a configuration
   change, not a fork.
3. As an operator, I want `MAILER_MODULE` to accept either a `default` export
   or a named `mailer` export, so that I can point it at either a
   purpose-written adapter file or an existing module that already exports a
   `mailer`.
4. As an operator, I want a wrong or missing `MAILER_MODULE` path to fail
   loudly at startup with a message naming the problem, so that I fix it
   immediately instead of discovering it when the first user cannot receive a
   reset email.
5. As an operator, I want a module that loads but does not export a valid
   `Mailer` to be rejected at startup with a clear message, so that a typo in
   my export shape does not silently fall back to the console transport.
6. As an operator, I want the transport to be installed before migrations
   run, so that a misconfigured transport fails the boot before the process
   has done any database work.
7. As a developer running kauth locally, I want `consoleMailer` to stay the
   default with no `MAILER_MODULE` set, so that the local auth flows are
   still complete and inspectable without me configuring email.
8. As a developer running the test suite, I want the absence of
   `MAILER_MODULE` to be fine in `NODE_ENV=test`, so that tests keep using
   the in-memory mailer they install themselves.
9. As a developer, I want a one-time warning the first time a mail is sent
   through the console transport, so that I am reminded the transport is not
   real without every send spamming my logs.
10. As an operator, I want `.env.example` to document `MAILER_MODULE` and the
    export contract, so that I know the hook exists and what shape my module
    must have.
11. As an operator, I want `backend/README.md`'s Email section to show the
    `MAILER_MODULE` path alongside the existing `setMailer` code example, so
    that the declarative and programmatic paths are both discoverable.
12. As an operator running the setup wizard, I want a stage that prompts for
    `MAILER_MODULE`, so that configuring the transport is part of the guided
    setup rather than something I read about later.
13. As an operator running the setup wizard, I want the email-verification
    stage to only offer to enable `REQUIRE_EMAIL_VERIFICATION` when a
    transport path has been provided, and to force it to `false` without
    asking when one has not, so that the wizard cannot walk me into locking
    every user out.
14. As a maintainer, I want the production fail-fast to be covered by a test
    that fails if the guard is removed, so that a future refactor cannot
    quietly reopen the "boots without a transport" hole.
15. As a maintainer, I want the mailer boot logic to be a testable unit
    rather than inline statements in `main()`, so that its behavior is
    exercised without spinning up the full server or a child process.
16. As an operator reading `docs/roadmap.md`, I want the mailer posture
    recorded as done in the security-considerations / operations narrative,
    so that the roadmap reflects that the console-transport-in-production
    risk is closed.
17. As an operator, I want the fail-fast message to point me at
    `MAILER_MODULE` and the README, so that I know exactly how to resolve it.
18. As a developer writing a transport adapter, I want the `Mailer` and
    `Mail` interfaces to remain the stable contract my module implements, so
    that the hook does not introduce a second mail abstraction.

## Implementation Decisions

### Configuration

- `config.ts` gains `MAILER_MODULE: z.string().optional()` in the schema and
  a corresponding `mailer_module` field on the exported `config` object
  (snake_case per convention). No validation of the path at config-parse
  time — the module is resolved and loaded by `bootMailer`, which owns the
  error reporting.

### `lib/mail.ts` — the single seam

All new runtime behavior lands in `lib/mail.ts`, which already owns
`consoleMailer`, `setMailer`, `sendMail`, and the `Mailer` / `Mail`
interfaces. No new module.

- **`mailerConfigured` flag** — a module-level boolean, initially `false`,
  set to `true` by `setMailer`. This is the single source of truth for "has
  an explicit transport been installed" and is what both the production
  fail-fast and the dev one-time warning read.

- **`bootMailer(options)`** — new exported async function, the epic's one new
  seam. Signature carries its environment dependency as a parameter, matching
  the injected-deps idiom of `gracefulShutdown` (`lib/shutdown.ts`):

  ```ts
  interface BootMailerOptions {
    nodeEnv: NodeEnv;          // injected, not read from config at call time
    modulePath?: string;       // defaults to config.mailer_module
  }
  async function bootMailer(options: BootMailerOptions): Promise<void>
  ```

  Behavior, in order:
  1. If `modulePath` (or `config.mailer_module`) is set: resolve it against
     `process.cwd()`, `await import` it, and locate a `Mailer` — prefer a
     named `mailer` export, fall back to `default`. Validate the resolved
     value is an object with a `send` function. On an unresolvable path,
     an import failure, or a missing/wrong-shape export, throw an `Error`
     whose message names `MAILER_MODULE`, the offending path, and the
     specific failure (not found / no valid export). Call `setMailer` with
     the located transport.
  2. If `modulePath` is not set: do nothing in step 1 — `consoleMailer`
     remains the default.
  3. Fail-fast: if `nodeEnv === "production" && !mailerConfigured`, throw an
     `Error` instructing the operator to set `MAILER_MODULE` (and pointing at
     the README's Email section). Mirrors the `config.ts` production
     secret-length block and the `config.node_env === "production"` idiom
     used in `config/cookies.ts` and `middlewares/error.ts`.

- **Dev one-time console-transport warning** — `sendMail` checks, on entry,
  whether the active transport is still the console default
  (`!mailerConfigured`) and whether the warning has already been emitted this
  process. If both, `logger.warn` once with a message that the console
  transport is not a real delivery channel and `MAILER_MODULE` should be set
  for any non-local use. A module-level `consoleWarningEmitted` boolean
  guards the once-per-process semantics. Never fires when a transport is
  installed; never fires more than once.

### `server.ts` wiring

- `main()` calls `await bootMailer({ nodeEnv: config.node_env })` as its
  **first** statement, before `applyMigrations()`. A throw from `bootMailer`
  propagates to the existing `main().catch(...)` handler, which logs
  `"startup failed"` and `process.exit(1)` — no new error handling needed.

### Setup wizard (`backend/scripts/setup.sh`)

- `TOTAL_STAGES` increments from 9 to 10.
- **New stage, inserted before the current "Email verification policy"
  stage**: "Mail transport". Explains kauth ships no transport, that
  `MAILER_MODULE` names an operator-supplied module exporting a `Mailer`
  (`default` or named `mailer`), and that production refuses to boot without
  it. Uses the existing `ask` + `write_env` helpers to capture
  `MAILER_MODULE`; leaving it blank writes nothing and notes that the
  console transport stays active (dev only).
- **"Email verification policy" stage becomes conditional** on whether a
  `MAILER_MODULE` value was provided (check the captured var or
  `_existing MAILER_MODULE`):
  - transport set → prompt as today ("Require verified email for login?"),
    now framed as "safe to enable".
  - transport blank → skip the prompt, `write_env REQUIRE_EMAIL_VERIFICATION
    false`, and `note` that it was forced off because no transport is
    configured. Add to `SKIPPED` a reminder to revisit once a transport
    exists.
- The renumbered later stages (cleanup schedule, first staff member) shift
  from 8/9 to 9/10 — stage headers are free text, just keep them ordered.

### Documentation

- `.env.example` — add a `MAILER_MODULE` entry (commented, with the export
  contract in the comment) near `REQUIRE_EMAIL_VERIFICATION`, and update that
  var's comment to reference the fail-fast.
- `backend/README.md` Email section — document `MAILER_MODULE` as the
  declarative path alongside the existing `setMailer` snippet; state the
  `default` / named `mailer` export contract and the production fail-fast.
- `docs/roadmap.md` — in the security-considerations / operations narrative,
  record that the console-transport-in-production risk is closed by the
  `MAILER_MODULE` requirement + production fail-fast.

### Tickets

Per the plan:
1. **Backend + wizard + docs**: `config.ts` var, `mailerConfigured` flag,
   `bootMailer`, `sendMail` one-time warning, `server.ts` wiring,
   `.env.example`, `backend/README.md`, setup-wizard stage + conditional
   verification stage.
2. **Docs-sync**: `docs/roadmap.md` note (the batch's standard close-out
   docs-sync ticket for this epic; may be folded with the register-oracle
   epic's docs-sync if that lands close behind — implementer's call at merge
   time).

## Testing Decisions

A good test here asserts on **observable boot behavior** — does `bootMailer`
throw, does `sendMail` route to the installed transport, does the warning
appear once — not on private module state beyond what the public surface
already exposes (`sendMail`'s routing, `logger` output).

**Seam: `bootMailer` in `lib/mail.ts`, exercised in-process.** No child
process (the register-oracle epic and `configEncryptionKey.test.ts` use the
`Bun.spawnSync` pattern, but this epic's `nodeEnv` parameter makes the
production path reachable in-process, so a child process buys nothing here).
The one-line `bootMailer` call in `server.ts:main()` is trusted wiring, not
separately tested.

New suite (e.g. `backend/tests/mailerPosture.test.ts`), with fixture
transport modules under a new `backend/tests/fixtures/` directory:

- A fixture exporting a valid `Mailer` as `default`, one exporting it as a
  named `mailer`, and one exporting something without a `send` method.
- Each test resets mailer state (`setMailer(createMemoryMailer())` /
  re-import discipline) so `mailerConfigured` and the one-time-warning flag
  do not leak between cases — follow `logging.test.ts`'s
  `beforeAll(setMailer(...))` / `afterAll(setMailer(createMemoryMailer()))`
  shape.

Cases:

1. `bootMailer({ nodeEnv: "development" })` with no module path → does not
   throw; `sendMail` still routes to the console transport.
2. `bootMailer({ nodeEnv: "production" })` with no module path → **throws**;
   message names `MAILER_MODULE`. *(mutation check: delete the fail-fast
   block, this test must fail.)*
3. `bootMailer` with `modulePath` pointing at the `default`-export fixture →
   does not throw; a subsequent `sendMail` is received by that fixture's
   transport (assert via the fixture recording sent mail, or a memory mailer
   it wraps).
4. Same for the named-`mailer`-export fixture.
5. `bootMailer` with a `modulePath` that does not resolve → throws; message
   names the path and "not found" (or equivalent).
6. `bootMailer` with `modulePath` at the no-`send` fixture → throws; message
   names the export-shape problem.
7. `bootMailer({ nodeEnv: "production" })` with a valid module path → does
   **not** throw (transport configured satisfies the guard).
8. One-time warning: with the console transport active, two `sendMail` calls
   produce exactly one `warn` line about the console transport; capture via
   the `captureLogs` helper pattern from `logging.test.ts`. With a transport
   installed via `bootMailer`, `sendMail` produces **no** such warning.

**Prior art**: `tests/configEncryptionKey.test.ts` (fail-fast on unsafe
config), `tests/shutdown.test.ts` (`gracefulShutdown` as an injected-deps
unit — the pattern `bootMailer` follows), `tests/logging.test.ts`
(`captureLogs`, `setMailer` lifecycle in `beforeAll`/`afterAll`).

**Not tested**: the setup wizard (`setup.sh`) has no test harness in this
repo and is generated/hand-audited per the `/wizard` skill — consistent with
the ops-hardening epic, which also shipped its wizard changes untested.
`.env.example` and README changes are docs.

## Out of Scope

- Shipping any concrete transport (SMTP, SES, Resend, etc.). kauth stays
  provider-agnostic; `MAILER_MODULE` names operator code.
- The register-oracle changes (generic `202`, username-first ordering,
  `REGISTER_DUPLICATE_EMAIL`, by-account limiter, ADR 0008, contract bump to
  0.6.0). That is the other half of epic 1, lands after this, and is the only
  part with contract impact — see `.scratch/deferred-closeout/plan.md`.
- Any change to `Mailer` / `Mail` interfaces, the `sendMail` best-effort
  error semantics, or `createMemoryMailer`.
- Retry, queueing, or delivery-status tracking for mail.
- Hot-reloading or re-resolving `MAILER_MODULE` after boot.
- A child-process / full-server boot test (explicitly dropped — the
  `nodeEnv` parameter makes in-process coverage sufficient).
- ADR — none for this epic (enforcement of an already-locked posture).

## Further Notes

- Load order matters: `bootMailer` runs before `applyMigrations()` so a
  misconfigured transport aborts the boot before any DB work. Keep it first
  in `main()`.
- The dev one-time warning is deliberately a `warn`, not an `error` — the
  console transport is a legitimate local-dev choice, the message is a
  reminder, not a failure.
- `config.mailer_module` is read inside `bootMailer` (via the default of its
  `modulePath` option), not passed from `server.ts`, so the production path
  and the module-resolution path share one code path regardless of caller.
- The test suite's global `tests/setup.ts` already installs
  `createMemoryMailer()` via `setMailer`, so `mailerConfigured` is `true` for
  the rest of the suite — the new suite must explicitly reset to the console
  transport for the warning cases and restore afterward.
- Contract version is untouched by this epic. The 0.6.0 bump belongs to the
  register-oracle work.
