import { type RequestHandler } from "express";
import config from "../config";
import { appError } from "../utils/errors";
import { tryRecordSecurityEvent } from "../lib/securityEvents";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const trusted = new Set(config.trusted_origins);

function originOf(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

/**
 * Rejects state-changing requests that a browser attributes to an untrusted
 * site. Requests carrying no origin information at all are allowed through:
 * those come from non-browser clients, which cannot be tricked into forging
 * a cross-site request in the first place.
 */
export const requireTrustedOrigin: RequestHandler = async (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    return next();
  }

  const origin = originOf(req.get("origin")) ?? originOf(req.get("referer"));
  const fetchSite = req.get("sec-fetch-site");

  if (!origin) {
    const declaredCrossSite =
      fetchSite !== undefined &&
      fetchSite !== "same-origin" &&
      fetchSite !== "none";

    if (declaredCrossSite) {
      return next(appError(403, "Untrusted request origin", "untrusted_origin"));
    }

    return next();
  }

  if (!trusted.has(origin)) {
    await tryRecordSecurityEvent({
      type: "SUSPICIOUS_ACTIVITY",
      ip: req.ip ?? null,
      userAgent: req.get("user-agent") ?? null,
      metadata: { reason: "untrusted_origin", origin, path: req.path },
    });

    return next(appError(403, "Untrusted request origin", "untrusted_origin"));
  }

  next();
};
