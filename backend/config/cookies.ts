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
  httpOnly: false,
  secure: isProd,
  sameSite: "lax",
  path: "/",
  maxAge: 30 * 24 * 60 * 60 * 1000,
};
