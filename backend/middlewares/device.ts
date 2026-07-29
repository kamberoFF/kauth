import { type RequestHandler } from "express";
import { UUID_REGEX } from "../constants/regex";
import { DEVICE_ID_HEADER } from "../constants/headers";
import { appError } from "../utils/errors";

export const requireDevice: RequestHandler = (req, _res, next) => {
  const deviceId = req.get(DEVICE_ID_HEADER)?.trim();

  if (!deviceId) {
    return next(
      appError(
        400,
        `Missing required header: ${DEVICE_ID_HEADER}`,
        "device_id_missing",
      ),
    );
  }

  if (!UUID_REGEX.test(deviceId)) {
    return next(
      appError(
        400,
        `Invalid ${DEVICE_ID_HEADER} format. Must be a valid UUID v4`,
        "device_id_invalid",
      ),
    );
  }

  req.deviceId = deviceId;
  next();
};
