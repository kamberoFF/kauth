import { GitHub, Google, type OAuth2Tokens } from "arctic";
import config from "../../config";
import { prisma } from "../prisma";
import { decrypt } from "../cryptoBox";
import type { ProjectOAuthCredential } from "../../generated/prisma/client";

/**
 * Derivation namespace for a Project's stored `client_secret` (ADR 0006's
 * blast-radius rule — distinct from the MFA secret and from `state` signing).
 */
const PROJECT_OAUTH_CONTEXT = "kauth:project-oauth";

export interface OAuthProfile {
  accountId: string;
  email: string | null;
  /**
   * Whether the provider vouches for the address. Linking to an existing kauth
   * account is only safe when this is true.
   */
  emailVerified: boolean;
  name: string | null;
  image: string | null;
}

export interface OAuthProvider {
  id: string;
  scopes: string[];
  usesPkce: boolean;
  createAuthorizationURL(state: string, codeVerifier: string): URL;
  validateAuthorizationCode(
    code: string,
    codeVerifier: string,
  ): Promise<OAuth2Tokens>;
  fetchProfile(tokens: OAuth2Tokens): Promise<OAuthProfile>;
}

function callbackUrl(providerId: string) {
  return `${config.app_url}/oauth/${providerId}/callback`;
}

async function getJson(url: string, accessToken: string) {
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      "user-agent": "kauth",
    },
  });

  if (!response.ok) {
    throw new Error(`${url} responded ${response.status}`);
  }

  return response.json();
}

interface GoogleUserInfo {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  picture?: string;
}

function googleProvider(credentials: {
  clientId: string;
  clientSecret: string;
}): OAuthProvider {
  const client = new Google(
    credentials.clientId,
    credentials.clientSecret,
    callbackUrl("google"),
  );
  const scopes = ["openid", "profile", "email"];

  return {
    id: "google",
    scopes,
    usesPkce: true,
    createAuthorizationURL: (state, codeVerifier) =>
      client.createAuthorizationURL(state, codeVerifier, scopes),
    validateAuthorizationCode: (code, codeVerifier) =>
      client.validateAuthorizationCode(code, codeVerifier),
    async fetchProfile(tokens) {
      const profile = (await getJson(
        "https://openidconnect.googleapis.com/v1/userinfo",
        tokens.accessToken(),
      )) as GoogleUserInfo;

      return {
        accountId: profile.sub,
        email: profile.email ?? null,
        emailVerified: profile.email_verified === true,
        name: profile.name ?? null,
        image: profile.picture ?? null,
      };
    },
  };
}

interface GitHubUser {
  id: number;
  login: string;
  name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

function githubProvider(credentials: {
  clientId: string;
  clientSecret: string;
}): OAuthProvider {
  const client = new GitHub(
    credentials.clientId,
    credentials.clientSecret,
    callbackUrl("github"),
  );
  const scopes = ["read:user", "user:email"];

  return {
    id: "github",
    scopes,
    // GitHub's OAuth app flow does not implement PKCE.
    usesPkce: false,
    createAuthorizationURL: (state) =>
      client.createAuthorizationURL(state, scopes),
    validateAuthorizationCode: (code) =>
      client.validateAuthorizationCode(code),
    async fetchProfile(tokens) {
      const accessToken = tokens.accessToken();
      const user = (await getJson(
        "https://api.github.com/user",
        accessToken,
      )) as GitHubUser;

      // The public profile email is often null or unverified, so the primary
      // address comes from the dedicated endpoint.
      const emails = (await getJson(
        "https://api.github.com/user/emails",
        accessToken,
      )) as GitHubEmail[];

      const primary = emails.find((entry) => entry.primary && entry.verified);

      return {
        accountId: String(user.id),
        email: primary?.email ?? user.email ?? null,
        emailVerified: primary !== undefined,
        name: user.name ?? user.login,
        image: user.avatar_url ?? null,
      };
    },
  };
}

export interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
}

export type OAuthProviderFactory = (
  credentials: OAuthCredentials,
) => OAuthProvider;

/**
 * The instance-default providers — one per built-in provider whose env
 * credentials are set, plus anything an operator registered by hand.
 * `getOAuthProvider` / `enabledProviders` read this map, so they keep meaning
 * "what this instance offers when a Project has no Provider app of its own".
 */
const providers = new Map<string, OAuthProvider>();

/**
 * Per-provider builders, keyed the same way as `providers`. Registered
 * unconditionally at module load for every built-in provider, so a Project can
 * bring its own credentials for a provider the instance never configured
 * (ADR 0009). `resolveProjectProvider` calls these with a Project's decrypted
 * secret.
 */
const factories = new Map<string, OAuthProviderFactory>();

factories.set("google", googleProvider);
factories.set("github", githubProvider);

if (config.oauth.google) {
  providers.set("google", googleProvider(config.oauth.google));
}

if (config.oauth.github) {
  providers.set("github", githubProvider(config.oauth.github));
}

/**
 * Extension point for providers kauth does not ship a client for. Call at
 * startup, before the first request is served.
 */
export function registerOAuthProvider(provider: OAuthProvider) {
  providers.set(provider.id, provider);
}

export function unregisterOAuthProvider(id: string) {
  providers.delete(id);
}

/**
 * Register a builder for a provider id — the seam a test uses to stand a `stub`
 * provider in front of `resolveProjectProvider` and assert the Project's
 * decrypted `clientSecret` actually reached construction.
 */
export function registerOAuthProviderFactory(
  id: string,
  factory: OAuthProviderFactory,
) {
  factories.set(id, factory);
}

export function unregisterOAuthProviderFactory(id: string) {
  factories.delete(id);
}

/** Whether `id` names a provider kauth can build a client for at all. */
export function hasOAuthProviderFactory(id: string) {
  return factories.has(id);
}

/**
 * The built-in provider ids — every provider with a registered factory,
 * whether or not this instance configured env credentials for it. The owner
 * management listing iterates this so a Project can be shown a provider it
 * could adopt even when the instance offers none.
 */
export function oauthProviderFactoryIds() {
  return [...factories.keys()];
}

export function getOAuthProvider(id: string) {
  return providers.get(id);
}

export function enabledProviders() {
  return [...providers.keys()];
}

/** The columns the owner listing reads off a credential row (it shows `client_id`). */
type CredentialFacts = Pick<
  ProjectOAuthCredential,
  "provider_id" | "client_id" | "mode" | "client_secret_enc"
>;

/**
 * An `OVERRIDE` row that can actually become a client: it carries a secret and
 * there is a factory to build it. The single predicate every consumer applies,
 * so `resolveProjectProvider`, `enabledProvidersForProject`, and the owner
 * listing cannot drift on what "configured" means.
 */
function overrideIsUsable(
  row: Pick<ProjectOAuthCredential, "provider_id" | "mode" | "client_secret_enc">,
) {
  return (
    row.mode === "OVERRIDE" &&
    row.client_secret_enc !== null &&
    factories.has(row.provider_id)
  );
}

export interface ProjectOAuthProviderView {
  provider: string;
  source: "instance" | "project";
  enabled: boolean;
  clientId: string | null;
}

/**
 * How `providerId` resolves for a Project, as an owner sees it: a `DISABLED`
 * row suppresses it; an `OVERRIDE` row shows the Project's own `client_id` and
 * counts as enabled only when a client could be built from it; no row means the
 * instance default (enabled iff this instance configured one). The `client_id`
 * is surfaced only for the Project's own override — never the operator's, never
 * the stored secret.
 */
export function describeProjectProvider(
  providerId: string,
  row: CredentialFacts | undefined,
): ProjectOAuthProviderView {
  if (!row) {
    return {
      provider: providerId,
      source: "instance",
      enabled: getOAuthProvider(providerId) !== undefined,
      clientId: null,
    };
  }

  if (row.mode === "DISABLED") {
    return { provider: providerId, source: "project", enabled: false, clientId: null };
  }

  return {
    provider: providerId,
    source: "project",
    enabled: overrideIsUsable(row),
    clientId: row.client_id,
  };
}

/**
 * The provider a given Project's OAuth flow should use for `providerId`:
 *
 *  - a usable `OVERRIDE` row → built via that provider's factory with the
 *    Project's decrypted credentials;
 *  - a `DISABLED` row or an unbuildable override → `undefined`;
 *  - no row → the instance default;
 *  - nothing configured → `undefined`.
 *
 * Constructed per request, never cached: an OAuth start is rare, a `decrypt` +
 * `new Google(...)` is negligible, and a cache would need invalidating on every
 * credential write (ADR 0009).
 */
export async function resolveProjectProvider(
  projectId: string,
  providerId: string,
): Promise<OAuthProvider | undefined> {
  const credential = await prisma.projectOAuthCredential.findUnique({
    where: {
      project_id_provider_id: {
        project_id: projectId,
        provider_id: providerId,
      },
    },
  });

  if (!credential) {
    return getOAuthProvider(providerId);
  }

  if (!overrideIsUsable(credential)) {
    return undefined;
  }

  // Guaranteed non-null / present by overrideIsUsable.
  return factories.get(providerId)!({
    clientId: credential.client_id,
    clientSecret: decrypt(credential.client_secret_enc!, PROJECT_OAUTH_CONTEXT),
  });
}

/**
 * The provider ids a given Project's login page should offer. A Project row
 * shadows the instance default for that provider entirely — exactly as
 * `resolveProjectProvider` treats it — so the two never disagree: a provider is
 * offered iff it has a usable `OVERRIDE` row, or no row at all and an instance
 * default. A `DISABLED` row (or an override with no buildable client) offers
 * nothing.
 */
export async function enabledProvidersForProject(
  projectId: string,
): Promise<string[]> {
  const rows = await prisma.projectOAuthCredential.findMany({
    where: { project_id: projectId },
    select: { provider_id: true, mode: true, client_secret_enc: true },
  });

  const configured = new Set(rows.map((row) => row.provider_id));

  const effective = new Set(
    enabledProviders().filter((id) => !configured.has(id)),
  );

  for (const row of rows) {
    if (overrideIsUsable(row)) {
      effective.add(row.provider_id);
    }
  }

  return [...effective];
}

/** The derivation context a Project's stored `client_secret` is sealed under. */
export { PROJECT_OAUTH_CONTEXT };
