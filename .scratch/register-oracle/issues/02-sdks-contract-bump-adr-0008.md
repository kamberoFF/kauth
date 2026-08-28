# 02 — SDKs, contract bump to 0.6.0, ADR 0008

Status: done

**What to build:** the SDKs learn the new register flow and the whole contract
moves to `0.6.0` in lockstep, and the re-decision is recorded as an ADR.

- **client-sdk:** `signUp(input: SignUpInput): Promise<void>` — it calls
  `POST /register` and, on success, simply resolves. No `setState`, no
  `captureDeviceId`, no state transition; the store stays `signedOut` and the
  caller must call `signIn` next. A duplicate-email `signUp` resolves
  successfully (the server no longer returns `duplicate_email`, so the SDK
  cannot surface it); `signUp` still throws `KauthError` on
  `duplicate_username` and `validation`. `SignUpResult` is deleted;
  `SignUpInput` is kept. `useSession().user` stays `null` after `signUp` (the
  field is kept for a future `/me`). The `signUp` doc comment and the README
  example are updated to register-then-`signIn`.
- **backend-sdk:** no API change (it has no register method) — contract
  version constant and package version bump only, with a changelog entry
  noting the coordinated bump.
- **Versions:** `CONTRACT_VERSION` → `"0.6.0"` in both SDKs; `package.json`
  version → `0.6.0` in `packages/client-sdk`, `packages/backend-sdk`, and
  `backend/`. The existing lockstep test already enforces all three agree with
  the server's advertised version.
- **ADR 0008** (`docs/adr/0008-register-drops-auto-login.md`): records that
  `/register` returns a generic `202` with no session and clients call `login`
  after; that this re-opens and re-decides the register contract ADR 0003
  froze, and why; the consequences (breaking change → coordinated-redeploy
  event per ADR 0003, both SDKs redeploy, weaker DX with no auto-login and
  `useSession().user` null until a `/me` endpoint exists, `signUp` can no
  longer surface `duplicate_email`); that device identity is now established
  only at `login`; and that `duplicate_username` deliberately stays a `409`.
  Non-goal: `signUp` does not internally chain to `signIn` (a mismatched
  password on a duplicate email would throw `auth_failed` and reopen the
  oracle).

**Blocked by:** 01 (the SDK tests run against the changed server; the ADR
documents the shipped behaviour)

- [x] `client.signUp(...)` resolves to `undefined`, leaves the store `signedOut`, and a subsequent `signIn` with the same credentials reaches `signedIn` with a working access token
- [x] A duplicate-email `signUp` resolves without throwing and creates no second account
- [x] `signUp` with a taken username still throws `KauthError` with code `duplicate_username`
- [x] `useSession` reports signed-out after `signUp` and flips only after `signIn`; the reactive-subscriber and device-identity SDK tests that relied on `signUp` creating a session get a `signIn` inserted after it
- [x] `SignUpResult` is removed; `SignUpInput` remains; the client-sdk README example shows register then `signIn`
- [x] `CONTRACT_VERSION` is `"0.6.0"` in both SDKs and `package.json` version is `0.6.0` in both SDK packages and in `backend/`; the contract-version lockstep test passes
- [x] backend-sdk changelog has an entry for the `0.6.0` coordinated bump
- [x] `docs/adr/0008-register-drops-auto-login.md` exists and covers the re-decision, the ADR-0003 breaking-change consequence, device-identity-at-login-only, the `duplicate_email` DX loss, and that `duplicate_username` stays
- [x] `bun test`, `bun run typecheck`, `bun run lint` green
