# kauth

Self-hosted auth backend for first-party apps, growing into a self-hosted,
multi-tenant auth platform: one kauth instance serving many independent
apps, each with its own isolated pool of end users.

## Language

**Project**:
A tenant. One customer's app, with its own isolated pool of Users, Sessions,
and linked-provider Accounts. Every user-owned table carries a `project_id`;
tables live in shared storage, not a separate schema or database per tenant.
_Avoid_: Tenant, org, workspace, app (when a specific tenant is meant, say
Project).

**Account**:
A linked external identity (e.g. a Google or GitHub OAuth account) attached
to a User. Distinct from the User itself, and from a "user account" in the
colloquial sense — that's just a User.
_Avoid_: OAuth account, provider account, connection.

**Contract version**:
The value of the `X-Kauth-Contract-Version` response header, one per kauth
release, bumped on any change to a response or error shape (including
purely additive ones). An SDK hard-fails on any mismatch between its own
built-against version and the server's — see ADR 0003. Deliberately not
"API version" in the Stripe sense: kauth never serves two contract versions
from one running instance at once, so there is no per-caller version
selection, only a single current one.
_Avoid_: API version (implies multi-version hosting, which this isn't).

**Device id**:
A server-issued identifier for one browser profile or app installation.
Kauth mints it when a session is created and hands it back via the HttpOnly
`kauth_device` cookie plus a `deviceId` field in the response body; clients
echo it on later requests (cookie first, `X-Device-Id` header as the channel
for non-cookie clients). It drives two policies — re-login replaces that
device's previous session (`replaced_by_new_login`) and refresh must match
the issuing context — but it authorizes nothing by itself: possessing a
device id grants no access. Deliberately not client-chosen (a client's own
random UUID was a risk signal doing an auth decision's job), and not a
fingerprint: it identifies an installation, not a person or physical device.
_Avoid_: device fingerprint; "client-supplied device id" (obsolete — the
server owns issuance now).

**Password policy**:
The minimum length a password must clear whenever it is set (registration,
change, reset). One Project-wide number per Project, with a deployment-wide
default beneath it. It governs only the act of setting a credential — login
carries no floor, so an older shorter credential can still sign in and be
rotated. Deliberately length-only: complexity rules and breach checking were
considered and declined. Never configurable from a browser: the Client SDK
can only ever be told what today's floor is; changing it requires the
Project owner's authenticated session.
_Avoid_: password rules, complexity requirements (not offered); "login
password validation" (login does not enforce this).

**Second factor**:
The proof an enrolled User must supply at sign-in beyond the first factor
(password or social login): a TOTP code or a Backup code. Opt-in per User;
a Project can mandate it for every User via a Grace period.
_Avoid_: 2FA; OTP (ambiguous).

**Enrollment**:
Binding a second factor to a User: a secret is generated, confirmed by a
first valid code, and only then active. A pending (unconfirmed) enrollment
challenges nothing at sign-in.
_Avoid_: setup; device registration (collides with Device id).

**Challenge**:
The deliberate pause between proven credentials and session creation for an
enrolled User, carried by a single-use, short-lived token bound to the
Device id that started sign-in. Answered as a normal response rather than an
error, so completing phase two — not the shape of phase one — is what
creates the session.
_Avoid_: step-up (the declined sensitive-action concept); MFA prompt.

**Backup code**:
A single-use offline stand-in for a TOTP code, shown exactly once at
Enrollment and stored only as a hash. Distinct from kauth's email recovery
tokens (password reset, email confirmation, OAuth exchange): those prove
control of an email channel, while a Backup code is something you hold
offline.
_Avoid_: recovery code (collides with kauth's Recovery-token vocabulary);
one-time password.

**Grace period**:
When a Project mandates a second factor, the window granted to each
unenrolled User starting at their first post-policy sign-in, after which
every request is refused until they enroll — except enrollment itself and
sign-out, so self-service escape always exists. Sign-in is never blocked;
the mandate walls usage, not entry.
_Avoid_: trial, exemption.

**Role**:
The `USER` | `ADMIN` column every User carries, scoped per Project like
everything user-owned. Its one server-defined meaning: ADMIN **inside the
reserved platform Project** marks Platform staff. Elsewhere it gates nothing
yet — per-project tenant roles wait for a consuming app to name them. Every
access token carries a role claim read at mint time, but kauth's own
authorization never reads it back: requireAuth re-selects the row on every
request, so a demotion bites immediately and the stale claim is cosmetic
(ADR 0007).
_Avoid_: permission (none exist); "admin" unqualified (always ask: admin of
which Project?).

**Platform staff**:
An operator of one kauth instance: an ADMIN User of the platform Project,
able to list all Projects, list any Project's users, and view or revoke any
Session through `/admin/*` — session-authenticated only, never reachable by
API key. Bootstrapped by `scripts/promoteStaff.ts`, extended thereafter by
staff promoting other platform users.
_Avoid_: superuser; global admin (there is no cross-instance tier); "kauth
admin" (ambiguous between staff and a tenant's own admins).

**Provider app**:
A Project's own OAuth application registered at Google or GitHub — its
client id, plus a client secret stored encrypted — so that Project's social
logins run through the tenant's own OAuth client instead of the instance-wide
one configured by env var. A Project with no Provider app for a given
provider inherits the instance one; it can also explicitly disable a provider
outright, offering neither.
_Avoid_: OAuth app (ambiguous — say Provider app for the per-Project one,
instance provider for the env-configured default); "OAuth credentials" (too
generic).
