export const DEVICE_ID_HEADER = "x-device-id" as const;
export const PROJECT_ID_HEADER = "x-project-id" as const;
export const CSRF_TOKEN_HEADER = "x-csrf-token" as const;

/**
 * Opts a client out of cookie-only transport. Cookies are always set; sending
 * `x-token-response: body` additionally returns the tokens in the JSON body,
 * which is what non-browser clients need and what browsers should never ask for.
 */
export const TOKEN_RESPONSE_HEADER = "x-token-response" as const;

export const CSRF_COOKIE = "kauth_csrf" as const;
export const SESSION_COOKIE = "kauth_session" as const;
export const REFRESH_COOKIE = "kauth_refresh" as const;
