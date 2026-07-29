import type { CookieOptions } from "express";
import config from "../config";

const isProd = config.node_env === "production";

export const refreshCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  path: "/refresh",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

export const csrfCookieOptions: CookieOptions = {
  // Readable by JS on purpose: the client has to echo it back in a header.
  httpOnly: false,
  secure: isProd,
  sameSite: "lax",
  path: "/",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};

/**
 * Holds the OAuth state and PKCE verifier across the round trip to the
 * provider. SameSite must stay "lax" rather than "strict": the user returns via
 * a top-level cross-site navigation, and a strict cookie would not be sent.
 */
export const oauthCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  path: "/oauth",
  maxAge: 10 * 60 * 1000,
};
