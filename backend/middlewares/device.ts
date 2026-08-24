import crypto from "node:crypto";
import { type Request, type RequestHandler } from "express";
import { UUID_REGEX } from "../constants/regex";
import { DEVICE_COOKIE, DEVICE_ID_HEADER } from "../constants/headers";
import { appError } from "../utils/errors";

/**
 * The server owns device identity: a client that presents no device context
 * gets one minted, and a client echoing a previously issued value — via the
 * HttpOnly cookie or the header — keeps working. The header therefore survives
 * only as an echo channel for non-cookie clients; nothing requires the client
 * to have generated an id itself anymore.
 *
 * The cookie wins over the header because it is what a browser supplies
 * automatically; a header sent alongside it can only come from page JavaScript
 * that has out-of-date state.
 */
function suppliedDeviceId(req: Request): string | undefined {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[
    DEVICE_COOKIE
  ];
  const fromHeader = req.get(DEVICE_ID_HEADER)?.trim();

  return fromCookie || fromHeader;
}

function invalidDevice(next: Parameters<RequestHandler>[2]) {
  return next(
    appError(
      400,
      `Invalid ${DEVICE_ID_HEADER} format. Must be a valid UUID v4`,
      "device_id_invalid",
    ),
  );
}

/** Session-creating endpoints: absence is fine, malformation is not. */
export const resolveDevice: RequestHandler = (req, _res, next) => {
  const supplied = suppliedDeviceId(req);

  if (supplied !== undefined && !UUID_REGEX.test(supplied)) {
    return invalidDevice(next);
  }

  req.deviceId = supplied ?? crypto.randomUUID();
  next();
};

/**
 * Echo endpoints (refresh, logout, OAuth exchange): the request must present
 * the device context its session was created with, so absence is an error.
 */
export const requireDevice: RequestHandler = (req, _res, next) => {
  const supplied = suppliedDeviceId(req);

  if (!supplied) {
    return next(
      appError(400, `Missing required header: ${DEVICE_ID_HEADER}`, "device_id_missing"),
    );
  }

  if (!UUID_REGEX.test(supplied)) {
    return invalidDevice(next);
  }

  req.deviceId = supplied;
  next();
};
