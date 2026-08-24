import type { CookieOptions } from "express";
import config from "../config";
import { ACCESS_TOKEN_TTL_MS } from "../lib/jwt";

const isProd = config.node_env === "production";

/**
 * SameSite "lax" is enough while the frontend and the API are same-site
 * (`localhost:5173` → `localhost:6767`, or `app.example.com` → `api.example.com`).
 * A frontend on a different registrable domain would need `SameSite=None` plus
 * `Secure`; that deployment shape does not exist yet, so it is not configurable.
 */
export const accessCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  path: "/",
  maxAge: ACCESS_TOKEN_TTL_MS,
};

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
 * Identifies the browser profile, not the session: it is issued by the server
 * at session creation and echoed on later requests so re-login can replace
 * that profile's previous session. It drives no auth decision by itself —
 * a stolen device id alone grants nothing — so unlike the token cookies it is
 * not scoped to a single endpoint and outlives any one session.
 */
export const deviceCookieOptions: CookieOptions = {
  httpOnly: true,
  secure: isProd,
  sameSite: "lax",
  path: "/",
  maxAge: 365 * 24 * 60 * 60 * 1000,
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
