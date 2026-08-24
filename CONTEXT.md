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
