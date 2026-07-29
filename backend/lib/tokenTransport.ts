import type { Request, Response } from "express";
import {
  REFRESH_COOKIE,
  SESSION_COOKIE,
  TOKEN_RESPONSE_HEADER,
} from "../constants/headers";
import { accessCookieOptions, refreshCookieOptions } from "../config/cookies";

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * Cookies are the default so that a browser client has no reason to hold a
 * token in JavaScript, where any XSS can read it. Clients that cannot use
 * cookies — native apps, server-to-server callers — opt back into body tokens
 * explicitly rather than every response carrying them by default.
 */
export function wantsBodyTokens(req: Request) {
  return req.get(TOKEN_RESPONSE_HEADER)?.trim().toLowerCase() === "body";
}

export function setAuthCookies(res: Response, tokens: IssuedTokens) {
  res.cookie(SESSION_COOKIE, tokens.accessToken, accessCookieOptions);
  res.cookie(REFRESH_COOKIE, tokens.refreshToken, refreshCookieOptions);
}

/**
 * A cookie is only cleared by a matching path, so the same options are reused —
 * minus maxAge, which Express turns back into a future `expires` and which would
 * therefore leave the cookie alive. Same reasoning as `readAndClearCookie` in
 * the OAuth controller.
 */
export function clearAuthCookies(res: Response) {
  const { maxAge: _accessMaxAge, ...accessClearOptions } = accessCookieOptions;
  const { maxAge: _refreshMaxAge, ...refreshClearOptions } =
    refreshCookieOptions;

  res.clearCookie(SESSION_COOKIE, accessClearOptions);
  res.clearCookie(REFRESH_COOKIE, refreshClearOptions);
}

export function readSessionCookie(req: Request) {
  return (req.cookies as Record<string, string> | undefined)?.[SESSION_COOKIE];
}

export function readRefreshCookie(req: Request) {
  return (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
}

/**
 * Sets the cookies and returns `body`, extended with the raw tokens only when
 * the caller opted in. Every endpoint that issues a session goes through here so
 * the decision is made once.
 */
export function sendAuthResponse(
  req: Request,
  res: Response,
  tokens: IssuedTokens,
  body: Record<string, unknown>,
  status = 200,
) {
  setAuthCookies(res, tokens);

  const payload = wantsBodyTokens(req)
    ? {
        ...body,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
      }
    : body;

  res.status(status).json(payload);
}
