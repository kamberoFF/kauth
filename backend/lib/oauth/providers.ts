import { GitHub, Google, type OAuth2Tokens } from "arctic";
import config from "../../config";

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

const providers = new Map<string, OAuthProvider>();

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

export function getOAuthProvider(id: string) {
  return providers.get(id);
}

export function enabledProviders() {
  return [...providers.keys()];
}
