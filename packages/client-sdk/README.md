# @kauth/client-sdk

Browser/mobile-safe client for a [kauth](../../README.md) instance: headless
sign-up, sign-in, sign-out, and an optional React session hook. Authenticate
with a project's **publishable** key — safe for public bundles; a secret key
never belongs here.

The platform sets `HttpOnly` session cookies on every response, so a browser
can run purely cookie-authenticated; the same calls also return tokens in the
body (`x-token-response: body`, sent by this SDK automatically), so native
apps and other non-cookie clients get identical behavior. Pick one transport
on the server side of your app and ignore the other.

## Usage

```ts
import { createKauthClient } from "@kauth/client-sdk";

const kauth = createKauthClient({
  baseUrl: "https://auth.example.com",
  publishableKey: "pk_live_…",
  // Persist the deviceId the server issues (see below) so returning users
  // replace their previous session instead of minting a new device.
  deviceId: localStorage.getItem("kauth_device") ?? undefined,
});

// Registration signs the user in and returns their profile.
const user = await kauth.signUp({
  email: "ada@example.com",
  username: "ada",
  password: "correct-horse-battery",
});

// Sign-in returns tokens only (no profile).
await kauth.signIn({ email: "ada@example.com", password: "correct-horse-battery" });

// Reactive state for your UI.
kauth.subscribe(() => console.log(kauth.getSnapshot().status));
```

Errors throw as `KauthError` carrying the platform's code (`duplicate_email`,
`auth_failed`, `validation`, …), not a generic wrapper.

## Two-phase sign-in (MFA)

A user enrolled in TOTP MFA cannot finish sign-in with credentials alone:
`signIn` pauses at a Challenge and the store stays signed out until their
code lands.

```ts
const result = await kauth.signIn({ email, password });

if (result.mfaRequired) {
  // Phase one paused: { mfaRequired: true, challengeToken,
  // expiresInSeconds, deviceId } — the same body the platform sends.
  // No session exists yet; show your code input. The deviceId is
  // captured automatically, like every session-creating response.
  const code = await promptForTotpCode(); // or a backup code
  await kauth.finishSignIn(result.challengeToken, code);
} else {
  if (result.mfaGraceEndsAt) {
    // The project mandates MFA and this user isn't enrolled yet: they have
    // until this deadline before requests start failing until they enroll.
    showEnrollmentBanner(result.mfaGraceEndsAt);
  }
}

// Either way, the store is signed in now.
await kauth.getSnapshot().status; // "signedIn"
```

A wrong code rejects with `mfa_code_invalid` while leaving the challenge
usable until it expires; a bad or replayed `challengeToken` rejects with
`token_invalid`. Enrollment itself (`POST /mfa/enrollment`, backup codes,
disable) is a session-authenticated flow — call the platform directly with
the access token, or drive it through your backend.

## Device identity

Device ids are server-issued: the first session-creating response mints one
and returns it as `deviceId` in the body (and as the HttpOnly
`kauth_device` cookie). This SDK captures it automatically and echoes it on
later calls. Pass a previously persisted value via the `deviceId` option so
a returning user's new sign-in replaces that device's old session rather
than accumulating them.

## React

```tsx
import { useSession } from "@kauth/client-sdk/react";

function Header() {
  const { isSignedIn, user } = useSession(kauth);
  return <nav>{isSignedIn ? user?.email ?? "Signed in" : "Sign in"}</nav>;
}
```

## Contract versioning

Every request is stamped against the contract version this SDK was built
with (`CONTRACT_VERSION`) and hard-fails on any mismatch with the server's
`X-Kauth-Contract-Version` header — see ADR 0003. A mismatch means the
operation may already have completed server-side; do not auto-retry.
