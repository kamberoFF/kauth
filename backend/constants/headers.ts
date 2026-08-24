export const DEVICE_ID_HEADER = "x-device-id" as const;
export const PROJECT_ID_HEADER = "x-project-id" as const;
export const CSRF_TOKEN_HEADER = "x-csrf-token" as const;
export const API_KEY_HEADER = "x-api-key" as const;

/**
 * ADR 0003: the value is kauth's own package release version, and any change
 * to a response or error shape bumps it. The SDKs exact-match it on every
 * request — see packages/backend-sdk.
 */
export const CONTRACT_VERSION_HEADER = "x-kauth-contract-version" as const;

/**
 * Opts a client out of cookie-only transport. Cookies are always set; sending
 * `x-token-response: body` additionally returns the tokens in the JSON body,
 * which is what non-browser clients need and what browsers should never ask for.
 */
export const TOKEN_RESPONSE_HEADER = "x-token-response" as const;

export const CSRF_COOKIE = "kauth_csrf" as const;
export const SESSION_COOKIE = "kauth_session" as const;
export const REFRESH_COOKIE = "kauth_refresh" as const;
