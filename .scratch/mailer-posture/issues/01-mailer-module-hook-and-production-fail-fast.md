# 01 — `MAILER_MODULE` hook + production fail-fast

**What to build:** kauth gains a declarative mail-transport hook and refuses to
run in production without one.

- An operator can name a transport module in a new optional `MAILER_MODULE`
  env var. At startup kauth resolves it against the working directory,
  imports it, accepts a `Mailer` from either its `default` export or a named
  `mailer` export, validates the value is an object with a `send` function,
  and installs it via `setMailer` — before anything else in `main()` runs, in
  particular before migrations.
- A missing/unresolvable path, an import failure, or a module that loads but
  has no valid `Mailer` export aborts the boot with an error naming
  `MAILER_MODULE`, the offending path, and the specific failure. The process
  exits non-zero through the existing `main().catch` handler.
- In production, if no transport is configured after the load step, kauth
  throws and exits non-zero — same fail-fast posture as an unsafe secret in
  `config.ts`. In development and test, `consoleMailer` stays the default.
- The first time a mail is actually sent through the console transport in a
  process, kauth logs a one-time `warn` that it is not a real delivery
  channel and `MAILER_MODULE` should be set for any non-local use. Never
  fires when a transport is installed; never fires more than once.
- `.env.example` and `backend/README.md`'s Email section document
  `MAILER_MODULE` and the `default` / named `mailer` export contract
  alongside the existing `setMailer` snippet.
- The setup wizard (`backend/scripts/setup.sh`) gains a "Mail transport"
  stage before the email-verification stage that captures `MAILER_MODULE`,
  and the email-verification stage becomes conditional: transport set →
  prompt as today ("safe to enable"); transport blank → skip the prompt,
  write `REQUIRE_EMAIL_VERIFICATION=false`, and note it was forced off.

**Blocked by:** None — can start immediately.

**Status:** done

Design source: `.scratch/mailer-posture/spec.md` (and
`.scratch/deferred-closeout/plan.md` → "Session 1 grilling outcome → Mailer
posture"). No ADR — this enforces an already-locked posture. No contract
version impact.

The one new seam is `bootMailer({ nodeEnv, modulePath? })` on `lib/mail.ts`,
carrying its environment as an injected parameter (the `gracefulShutdown`
idiom in `lib/shutdown.ts`), so the production path is reachable in-process.
`config.mailer_module` is read inside `bootMailer` as the default of its
`modulePath` option, so caller and production path share one code path.
`mailerConfigured` is a module-level flag set by `setMailer` and is the
single source of truth for both the fail-fast and the one-time warning.

- [x] `config.ts` has `MAILER_MODULE: z.string().optional()` and the exported
      config exposes `mailer_module` (snake_case per convention)
- [x] `lib/mail.ts` has a `mailerConfigured` module flag set to `true` by
      `setMailer` — see design note below: `setMailer` sets it to
      `next !== consoleMailer`, so `setMailer(consoleMailer)` resets to the
      unconfigured state (the spec's own test-reset instruction requires this)
- [x] `bootMailer({ nodeEnv, modulePath? })` is exported from `lib/mail.ts`;
      `modulePath` defaults to `config.mailer_module`
- [x] With a module path set, `bootMailer` resolves it against
      `process.cwd()`, imports it, prefers a named `mailer` export and falls
      back to `default`, validates a `send` function, and calls `setMailer`
- [x] An unresolvable path, an import failure, and a missing/wrong-shape
      export each throw an `Error` naming `MAILER_MODULE`, the path, and the
      specific failure (`ERR_MODULE_NOT_FOUND` → "no module found at that
      path"; other import errors → "it failed to load: …"; bad export shape →
      "exports no valid Mailer …")
- [x] With no module path and `nodeEnv === "production"`, `bootMailer` throws
      an `Error` instructing the operator to set `MAILER_MODULE` and pointing
      at the README
- [x] With no module path and `nodeEnv` development or test, `bootMailer`
      does not throw and the console transport remains active
- [x] `server.ts:main()` calls `await bootMailer({ nodeEnv: config.node_env })`
      as its first statement, before `applyMigrations()`
- [x] `sendMail` emits exactly one `logger.warn` per process about the
      console transport, only while no explicit transport is installed
- [x] New in-process suite `tests/mailerPosture.test.ts` with fixture
      transport modules under `tests/fixtures/`: default-export valid,
      named-`mailer`-export valid, and no-`send` invalid
- [x] Tests cover: no-path + development (no throw, console still routes);
      no-path + production (throws); default-export fixture (installs, mail
      received); named-export fixture (installs); unresolvable path (throws);
      no-`send` fixture (throws); valid path + production (no throw);
      one-time warning fires once over two `sendMail` calls and not at all
      with a transport installed
- [x] Mutation check recorded: deleting the `nodeEnv === "production" &&
      !mailerConfigured` block was verified twice to make
      "throws in production, naming MAILER_MODULE" fail (9 pass / 1 fail),
      then restored (10 pass)
- [x] Test state is reset between cases so `mailerConfigured` and the
      one-time-warning flag do not leak — `beforeEach(setMailer(consoleMailer))`
      per case, `afterAll` restores the memory mailer for the rest of the run
- [x] `.env.example` documents `MAILER_MODULE` (commented, with the export
      contract) near `REQUIRE_EMAIL_VERIFICATION`, whose comment now
      references `MAILER_MODULE`
- [x] `backend/README.md` Email section documents `MAILER_MODULE`, the
      `default` / named `mailer` export contract, and the production
      fail-fast
- [x] `backend/scripts/setup.sh`: `TOTAL_STAGES` becomes 10; a "Mail
      transport" stage is inserted before the email-verification stage and
      captures `MAILER_MODULE` via `ask` + `write_env` (blank writes nothing)
- [x] The email-verification stage is conditional on a `MAILER_MODULE` value:
      set → prompt as today; blank → no prompt, `write_env
      REQUIRE_EMAIL_VERIFICATION false`, a `note` explaining why, and a
      `SKIPPED` reminder to revisit
- [x] `bun test`, `bun run typecheck`, `bun run lint` all green

## Comments

### Implemented 2026-08-28 (`/implement`)

All backend + wizard + docs changes landed in one commit. Files:
`backend/config.ts`, `backend/lib/mail.ts`, `backend/server.ts`,
`backend/scripts/setup.sh`, `backend/.env.example`, `backend/README.md`,
`backend/tests/mailerPosture.test.ts`, `backend/tests/fixtures/{validDefaultMailer,validNamedMailer,invalidMailer}.ts`.

**Design deviation — `mailerConfigured`.** The spec says "a `mailerConfigured`
module flag set to `true` by `setMailer`", but also (Further Notes) that the
new suite "must explicitly reset to the console transport for the warning
cases" — an unconditional `true` makes that impossible without module
re-import, which Bun does not support cleanly. Resolved by having `setMailer`
set `mailerConfigured = next !== consoleMailer`: installing a real transport
configures one, installing the built-in `consoleMailer` (the only way back to
the unconfigured state) does not. Side benefit: a deploy that explicitly does
`setMailer(consoleMailer)` in production now correctly fails the boot.
`setMailer` also resets the one-time-warning flag so the per-transport warning
semantics survive a transport swap. Both code-review axes (Standards, Spec)
flagged this as a defensible-but-undocumented deviation; recorded here.

**Code review** (`/code-review`, two parallel sub-agents): Standards found no
hard violations — minor judgement calls (a `captureLogs` copy in the new suite,
a mixed rejection-assertion idiom) were addressed by dropping the hand-rolled
`rejectionOf` helper for `.rejects.toThrow(/…/)`. Spec found the two items now
resolved: the mutation check is recorded above, and the unresolvable-path vs
import-failure error messages were split into explicit branches.

Ticket 02 (docs-sync of `docs/roadmap.md`) remains open and is unblocked by
this.
