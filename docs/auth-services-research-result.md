# Building a Production-Grade Auth-as-a-Service in 2026: Feature Set, Security, DX, and Architecture

## TL;DR
- **Build on primitives, don't roll pure-from-scratch, and don't fork a monolith.** For a TypeScript developer, the current best practice is to compose the pilcrowonpaper stack (Oslo `@oslojs/*` crypto/encoding/otp/webauthn packages + Arctic OAuth clients) and follow the Copenhagen Book / Lucia session pattern — or study better-auth's plugin architecture — rather than implementing crypto yourself or adopting Keycloak/Ory's heavyweight infrastructure.
- **The 2026 security baseline is concrete and non-negotiable:** Argon2id (19 MiB / t=2 / p=1 minimum) for passwords, opaque SHA-256-hashed server-side session tokens in httpOnly/Secure/SameSite=Lax cookies (not JWTs in localStorage), OAuth 2.1 authorization-code-plus-PKCE for all clients, refresh-token rotation with reuse detection and token-family revocation, and passkeys/WebAuthn as the flagship phishing-resistant method.
- **Developer experience is the product.** The winners (Clerk, better-auth) win on drop-in framework SDKs, typed clients, secure defaults, webhooks (Svix-style HMAC-signed events), and documentation. Ship a framework-agnostic core HTTP/SDK layer plus thin framework adapters, and design your database schema (users, sessions, accounts, verifications) to be inspectable and ownable.

## Key Findings

1. **A "complete" auth service in 2026 spans four method tiers:** password (with breach-checking), magic links / email OTP, OAuth/OIDC social login, and passkeys/WebAuthn — with TOTP and backup codes for MFA and SMS treated as a deprecated, "restricted" fallback.
2. **Opaque server-side sessions beat JWTs for first-party app auth.** JWTs remain useful for cross-service/stateless authorization, but their inability to be revoked, plus a long tail of `alg` confusion and `none`-algorithm vulnerabilities, make hashed opaque tokens the safer default for a session system.
3. **OAuth 2.1 is the standard to target**, consolidating the mitigations of RFC 9700 "Best Current Practice for OAuth 2.0 Security" (BCP 240, updating RFCs 6749/6750/6819), published January 2025 by T. Lodderstedt, J. Bradley, A. Labunets & D. Fett, which states: *"Authorization servers MUST support PKCE [RFC7636]."* That means mandatory PKCE for all clients, exact redirect-URI matching, no implicit grant, no ROPC, no tokens in query strings.
4. **NIST SP 800-63B-4 (2024/25) materially changed password rules** — no composition rules, no periodic rotation (both now "SHALL NOT"), mandatory breach blocklist, and a raised minimum length — and SMS OTP is now "restricted."
5. **Lucia's deprecation (March 2025) is the defining signal for architecture choice:** its author concluded a universal library with database adapters was the wrong abstraction and pivoted to teaching from-scratch session code, spinning the reusable crypto into Oslo/Arctic. better-auth then filled the "batteries-included library" niche.
6. **The reference implementations to study** cluster into TypeScript-native (better-auth, Lucia learning resource, SuperTokens), Go cloud-native (Ory, Zitadel), and heavyweight enterprise (Keycloak) — each embodying a different architecture tradeoff.

## Details

### 1. Core Feature Set

**Authentication methods (in priority order for 2026):**
- **Email + password** with a breached-password check. Per NIST SP 800-63B-4 (§3.1.1.2), verifiers SHALL check new passwords against a blocklist of compromised/common passwords (e.g., Have I Been Pwned's k-anonymity range API), SHALL NOT impose composition rules, and SHALL NOT require periodic rotation. Minimum length: NIST-4 requires 15 characters for single-factor passwords, 8 minimum for passwords used inside an MFA flow, and recommends allowing at least 64.
- **Passkeys / WebAuthn (FIDO2)** — the flagship. Store only the public key, credential ID, and signature counter; never private keys. Use an identifier-first flow with Conditional UI (`autocomplete="webauthn"`) rather than a separate "Sign in with passkey" button, which measurably increases adoption. Use a maintained server library (SimpleWebAuthn in Node, or `@oslojs/webauthn` for parsing/verification) rather than implementing the CBOR/attestation parsing yourself. Microsoft announced on 1 May 2025 (its first "World Passkey Day") that brand-new consumer accounts are "passwordless by default"; per Joy Chik and Vasu Jakkal's blog, *"users signing in with passkeys are three times more successful at getting into their account than password users (about 98% versus 32%)"* and *"we see nearly a million passkeys registered every day."* Adoption is now mainstream.
- **OAuth / social login** (Google, GitHub, Apple, etc.) via authorization-code + PKCE. Arctic (arcticjs.dev) provides typed OAuth 2.0 clients for 50+ providers and is the natural building block for a TS service.
- **Magic links / email OTP** — good passwordless option; treat the link token as a high-security server-side token (SHA-256 hashed, single-use, short TTL).
- **MFA:** TOTP (RFC 6238, HMAC-SHA1, 6 digits, 30-second step) is the software-based default; verify with a ±1 step window for clock drift and mark codes single-use. Generate **backup/recovery codes** at enrollment (hash them like passwords). **SMS is deprecated** — NIST-4 classifies PSTN OTP as "restricted" and it is no longer AAL2-preferred due to SIM-swap/SS7 risk. The threat scale motivates this: per Microsoft's 1 May 2025 security blog, *"Last year, we observed a staggering 7,000 password attacks per second – more than double the rate from 2023."* Offer SMS only as a last-resort fallback with risk signals (device swap, SIM change, number porting).

**Session management:**
- **Opaque server-side tokens are the recommended default.** The Copenhagen Book pattern: generate ≥112 bits of entropy (120–256 recommended; e.g., 15 random bytes from a CSPRNG encoded as a 24-char base32 string), store only the **SHA-256 hash** of the token in the database, and validate by hashing the incoming token. A fast hash is acceptable here (unlike passwords) because the token already has 120+ bits of entropy and is unguessable ("an offline brute-force attack is impossible," per Lucia). Lucia's newer variant uses a split `id.secret` token where only the secret's SHA-256 hash is stored.
- **Sliding expiration:** default 30-day expiry, extended by 30 days whenever used within the second half of the window; optionally combine with an absolute cap (NIST-4 recommends a reauthentication overall timeout of ≤24h and inactivity timeout ≤1h at AAL2). Invalidate all of a user's sessions on password change, permission/role change, or email verification. Create a fresh session on every sign-in (session-fixation defense).
- **JWTs**: use for stateless cross-service authorization, not as the primary revocable session. If used: short-lived access tokens (5–15 min), allowlist the algorithm explicitly, reject `none`, never mix symmetric/asymmetric, use a strong ≥32-byte HS256 secret or asymmetric keys with `kid`-versioned rotation, and validate `iss`, `aud`, `exp`, `iat`, `nbf`.
- **Refresh token rotation with reuse detection:** each refresh issues a new refresh token and invalidates the old; track a token "family"; if an already-used token is presented, revoke the entire family (a strong theft signal). Add a short grace window (a few seconds) to handle legitimate race conditions. OWASP guidance: refresh tokens should be either sender-constrained (mTLS/DPoP) or rotated.

**User management:** registration, email verification, password reset (single-use SHA-256-hashed tokens with short expiry, generic responses), account linking (auto-link only on verified matching email while signed in), and user roles/permissions. Use **RBAC** as the default; reach for **ABAC/ReBAC** (e.g., OpenFGA/Zanzibar-style) only when relationship- or attribute-based rules demand it.

**Multi-tenancy:** For a service meant to be embedded in many apps, model **organizations/tenants as first-class**. Every authorization decision must be tenant-scoped ("is user an admin *in this tenant*", not "is user an admin"). Put a `tenant_id` on every row, enforce at schema + runtime + tests, and issue tenant-scoped tokens (claims like `tenantId`, `roles`). Three isolation models: row-level (`tenant_id` column; scales to tens of thousands of tenants), schema-per-tenant (hundreds), or database-per-tenant (max isolation, least efficient). Row-level with enforced checks is the pragmatic default.

**Admin APIs & dashboard, rate limiting, audit logging:** Provide a management API (create/list/update/delete users, sessions, orgs) separate from the end-user auth API. Rate-limit per-account (not just per-IP) for login/reset; implement account lockout with a threshold/observation-window/lockout-duration policy; add bot detection, breached-password and disposable-email checks, and impossible-travel/geo signals. Audit-log all security-relevant events (logins, failures, MFA changes, role changes, token revocations) — event-sourced designs (like Zitadel's) give complete audit trails.

### 2. Security Best Practices

**Password hashing (OWASP Password Storage Cheat Sheet, current):** Use **Argon2id**, minimum m=19 MiB, t=2, p=1 (an equivalent alternative is m=46 MiB/47104 KiB, t=1, p=1). Fallbacks: scrypt (N=2^17, r=8, p=1), bcrypt (work factor ≥10, and note the 72-byte input limit), or PBKDF2-HMAC-SHA256 (600,000 iterations) where FIPS-140 compliance is required. Argon2id is the recommended choice for new 2026 projects (RFC 9106, standardized September 2021). Salt per password (≥ NIST's 32-bit minimum; 16 bytes is common). Consider a **pepper** (HMAC/encrypt the hash with a key stored separately, ideally in an HSM/KMS) as defense-in-depth. Never use fast hashes (SHA-256, MD5) for passwords.

**JWT security:** algorithm allowlisting, reject `none`, avoid `jwk`/`jku`/`kid` header-injection (SSRF) by fetching keys only from a trusted JWKS allowlist, rotate signing keys (~every 90 days) with `kid` versioning keeping recent history. RFC 8725 (JWT BCP) enumerates the canonical mitigations.

**Cookies / CSRF:** session cookies must be `HttpOnly`, `Secure`, `SameSite=Lax` (Lax is the recommended default; `Strict` for banking-grade). Use the `__Host-` prefix for maximum binding. Do not set a cookie for a parent domain (subdomain-sharing risk). SameSite is **not sufficient CSRF protection on its own** — add the synchronizer-token pattern for stateful apps or signed double-submit cookies for stateless, plus an Origin/Fetch-metadata header check. Never store session tokens in localStorage (XSS-exfiltratable).

**OAuth2/OIDC compliance:** target **OAuth 2.1 / RFC 9700** — authorization-code + PKCE (S256 method; verifier ≥43 chars) for *all* client types, exact-string redirect-URI matching (no wildcards), a cryptographically random `state` per request, HTTPS everywhere, tokens only in headers/POST bodies (never query strings), no implicit grant, no ROPC.

**Attack-vector checklist:** session fixation (rotate session ID on login), token replay (sender-constrained tokens / DPoP, short TTLs), timing attacks (constant-time comparisons; run the same password-hash code path even for nonexistent users), enumeration (generic "if this account exists, we sent an email" responses on login/registration/reset + equal response timing), OAuth open redirect (exact redirect matching), XSS→token theft (httpOnly cookies + CSP), CSRF (above).

**Secrets & encryption at rest:** Store signing/encryption keys in a KMS/HSM/Vault, separate from the database. Encrypt sensitive PII and TOTP secrets at rest with AES-256; the TOTP shared secret must be encrypted at rest since anyone holding it can mint the user's codes.

**Standards to follow:** **OWASP ASVS 5.0**, released 30 May 2025 at Global AppSec EU Barcelona — ~350 requirements across 17 chapters, up from 286 requirements in 14 chapters in v4.0.3, adding dedicated web-frontend-security and self-contained-tokens chapters — as your verification checklist; plus the OWASP Authentication / Password Storage / CSRF cheat sheets, and **OWASP Top 10 A07 "Identification and Authentication Failures."** Target ASVS Level 2 for a production auth service.

**GDPR/PII:** Passwords are hashed (never encrypted/reversible). For other PII, encryption at rest is strongly recommended (not strictly mandated) — GDPR Art. 32 "appropriate technical measures"; AES-256 at rest, TLS 1.3 in transit is the common standard. Support data-subject rights: hard-delete (right to erasure), export (portability), data minimization, and audit logging. The stakes: British Airways was fined £20m by the UK ICO in October 2020 (reduced from the initial £183.39m notice of intent issued 4 July 2019) over the 2018 Magecart breach affecting ~429,612 customers/staff; the ICO found the compromised data included *"log in, payment card, and travel booking details as well name and address information."*

### 3. Developer Experience & Integration Design

**What the winners do:**
- **Clerk** wins DX for React/Next.js with drop-in components (`<SignIn/>`, `<UserButton/>`, `<UserProfile/>`, `<OrganizationSwitcher/>`) that manage the full session lifecycle via context, framework middleware, and a downloadable OpenAPI spec — basic integration in under 15 minutes. Tradeoff: bundle size (its main bundle can be up to ~50% of app size with prebuilt components) and SaaS lock-in.
- **Auth0** is the "swiss-army knife" — deepest protocol support (SAML/LDAP/OIDC), but more configuration-first and redirect-based; setup measured in hours-to-weeks.
- **better-auth** is the framework-agnostic, TypeScript-first, self-hosted model: a core plus a **plugin ecosystem** (2FA, passkey, organization, magic link, admin) where each plugin can extend the DB schema, add server endpoints, and expose typed client methods. It uses an **adapter layer** rather than shipping its own ORM, so you own your database. It supports Next.js, Nuxt, SvelteKit, Astro, Hono, and 20+ frameworks.
- **Supabase Auth** wins when already in the Supabase/Postgres RLS ecosystem.

**API design:** offer **both** a clean REST/HTTP API (for framework-agnostic and non-JS consumers) **and** a typed SDK-first client (the DX multiplier for TS users). better-auth's typed client that "knows about" enabled plugins is the model to emulate.

**Webhooks/events:** emit events (`user.created`, `session.created`, `session.revoked`, `user.updated`, `organization.created`, etc.). Follow Svix conventions: **HMAC-signed** payloads (not basic auth or URL keys), a timestamp header for replay protection (verify within tolerance, e.g. within 15s), retries with delivery logs, and a documented event catalog. Include the event type as a top-level payload key.

**Framework-agnostic vs specific:** the proven pattern is a **framework-agnostic core** (pure functions + an HTTP handler) wrapped by **thin framework adapters** (Next.js, Angular, Express, Hono, etc.). This is exactly the tradeoff that broke Lucia (supporting every DB/runtime via adapters became untenable) — so keep the core small and push DB specifics to an adapter interface, and don't over-promise universal coverage.

**Docs/onboarding:** copy-pasteable quickstarts, framework-specific paths, interactive examples, secure-by-default config, and a CLI for schema generation/migrations (better-auth ships one) drive adoption. Surveys cited by Clerk report 90% of developers rely on docs as their primary resource and 45% cite poor docs as the top integration barrier.

### 4. Architecture Recommendations

**Tech stack:** Node.js + TypeScript is a fine choice given the developer's background and the maturity of the TS auth ecosystem. Use PostgreSQL (relational integrity for users/sessions/accounts, JSONB for flexible metadata, row-level security available), an adapter interface over the ORM (Drizzle or Prisma), and Redis as optional secondary storage for sessions/rate-limiting. Compose Oslo (`@oslojs/crypto`, `@oslojs/encoding`, `@oslojs/otp`, `@oslojs/webauthn`, `@oslojs/jwt`) + Arctic for OAuth + SimpleWebAuthn or `@oslojs/webauthn` for passkeys + a native Argon2id binding. (Note: the older monolithic `oslo` npm package is deprecated in favor of the scoped `@oslojs/*` packages.)

**Standalone microservice vs embedded library:**
- *Embedded library* (better-auth model): lowest latency (no network hop, in-process), simplest ops, owns the app's DB. Best when the "service" is consumed by TS apps you control. Downside: not language-agnostic; each app embeds it.
- *Standalone auth service* (Keycloak/Ory/Zitadel model): centralized, language-agnostic (any app hits it over HTTP/OIDC), independently scalable — but adds a network hop (documented at ~50–200 ms per remote authz call), a potential single point of failure, and ops burden. Mitigate latency by issuing verifiable JWTs that resource servers validate locally against a JWKS endpoint (no per-request call to the auth service), reserving the central service for issuance, refresh, and revocation.
- **Recommendation:** Since the stated goal is "easily integratable into other applications," build a **standalone OIDC-compliant auth service** as the product, but ship a **framework-agnostic TS SDK + thin adapters** so the integration DX feels library-grade. Use short-lived JWTs verified locally + opaque refresh/session tokens managed centrally with rotation and revocation — the hybrid that gets you both low latency and revocability.

**Database schema (the canonical 4 + extensions):**
- `user` (id, email, emailVerified, name, image, createdAt, updatedAt)
- `session` (id, userId FK, token/tokenHash, expiresAt, ipAddress, userAgent, createdAt) — sliding expiry
- `account` (id, userId FK, providerId, accountId, accessToken, refreshToken, idToken, expiresAt, scope, **password** for the email/password credential) — OAuth + credential storage
- `verification` (id, identifier, value, expiresAt) — email verification, magic links, reset tokens
- Extensions for a full build: `passkey` (credentialId, publicKey, counter, userId), `twoFactor`/`totp` (encrypted secret, backupCodes), `organization` + `member` + `invitation`, `oauth_application` if you become an OIDC provider, and `audit_log`. Use `ON DELETE CASCADE` from `user` so deleting a user removes all dependent rows (no orphans). This is better-auth's/Auth.js's proven layout.

**Build custom vs build on a foundation:** 
- *Pure from-scratch* (implement crypto, OAuth, WebAuthn parsing yourself): **not recommended** — high risk of subtle vulnerabilities.
- *On primitives (recommended):* Oslo + Arctic + SimpleWebAuthn give you audited, runtime-agnostic building blocks while you own the session/DB logic — exactly the path Lucia now teaches. This gives maximum control with minimized crypto risk and is the best fit for a "clean, ownable" custom service.
- *Fork/extend an existing framework:* building on better-auth's primitives or studying SuperTokens' core is reasonable if you want a head start, at the cost of inheriting their abstractions.

### 5. Reference Projects Worth Studying

- **Lucia (learning resource) + The Copenhagen Book + Oslo/Arctic** — the canonical modern "how to implement sessions/auth from scratch in TS" curriculum by pilcrowonpaper. Start here. (Note the Copenhagen Book now points to auth.pilcrowonpaper.com as the newer canonical home.)
- **better-auth** — the reference for framework-agnostic TS library DX, plugin architecture, adapter layer, and schema design.
- **SuperTokens** — open-source, self-hostable, strong session security (rotation, hijacking detection, CSRF, session-fixation defenses baked in); good middle ground of library + service.
- **Ory (Kratos/Hydra/Keto/Oathkeeper)** — API-first, cloud-native, headless Go microservices; study for clean API design and separation of identity/OAuth/permissions, but note it's DIY to wire into a UX.
- **Zitadel** — Go, event-sourced (great audit trails), native multi-tenancy, modern API-first DX; strong reference for multi-tenant SaaS auth.
- **Keycloak** — the mature, protocol-complete (OIDC/OAuth2/SAML2/LDAP) enterprise standard; heavy (JVM), but the reference for breadth of features and admin capabilities.
- **Authelia** — lightweight reverse-proxy companion (SSO/2FA), tiny footprint (compressed image under 20 MB); reference for the proxy/forward-auth pattern.

## Recommendations

**Stage 1 — MVP (weeks):** Ship email/password (Argon2id, breach-check via HIBP), opaque SHA-256-hashed server-side sessions in `HttpOnly; Secure; SameSite=Lax` cookies with sliding expiry, email verification + password reset (single-use hashed tokens), and per-account rate limiting + lockout. Build the framework-agnostic core + a Next.js adapter first. Adopt the canonical 4-table schema. Benchmark Argon2id to ~250–400 ms on your server hardware.

**Stage 2 — Table stakes:** Add OAuth (Arctic), TOTP + backup codes, passkeys/WebAuthn (SimpleWebAuthn) with identifier-first + Conditional UI, HMAC-signed webhooks, and an admin/management API. Publish a typed SDK and quickstart docs.

**Stage 3 — Platform:** Add organizations/multi-tenancy (row-level `tenant_id`, tenant-scoped tokens), RBAC, full OIDC-provider mode (so you become an IdP with authorization-code + PKCE), refresh-token rotation with family-based reuse detection, and audit logging. Verify against OWASP ASVS v5 (target L2).

**Thresholds that change the plan:**
- If consumers are **non-JS/polyglot** → prioritize the standalone OIDC service + JWTs-verified-locally over the embedded-library path.
- If you need **SAML/LDAP/enterprise SSO** → this is where custom builds stop being worth it; front with or study Keycloak/Zitadel rather than reimplementing SAML.
- If you need **FIPS-140 compliance** → switch password hashing to PBKDF2-HMAC-SHA256 (600k iterations).
- If **fine-grained/relationship authorization** emerges (sharing, hierarchies) → adopt an OpenFGA/Zanzibar-style ReBAC engine rather than extending RBAC.
- If **ops burden** of self-hosting the standalone service becomes the bottleneck → the embedded better-auth-style library is the lower-maintenance path.

## Caveats
- **Rolling your own auth carries real, asymmetric risk:** a single missed CSRF/enumeration/`alg`-confusion vector can compromise your entire user base. Use audited primitives, follow ASVS v5, and get a security review before production.
- **The password-length figure is contested in secondary sources.** OWASP historically cited an 8-char minimum; NIST SP 800-63B-4 raised the single-factor minimum to 15 (8 only inside MFA flows). Pick a policy explicitly and document which standard you follow.
- **OAuth 2.1 is still a late-stage IETF draft** (built on the finalized RFC 9700, Jan 2025); its technical requirements are stable and widely adopted, but it is not yet a published RFC.
- **The Copenhagen Book and legacy `oslo` monolith carry deprecation/relocation banners** — use the scoped `@oslojs/*` packages, and note pilcrowonpaper's newer canonical home is auth.pilcrowonpaper.com.
- Several data points here (adoption stats, "fastest setup" and "bundle size" claims, latency ranges) come from vendor blogs and marketing pages and should be treated as directional rather than independently audited.