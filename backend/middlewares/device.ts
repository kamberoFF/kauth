import { type RequestHandler } from "express";
import { UUID_REGEX } from "../constants/regex";
import { DEVICE_ID_HEADER } from "../constants/headers";

export const requireDevice: RequestHandler = async (req, res, next) => {
  const deviceId = req.get(DEVICE_ID_HEADER)?.trim();

  if (!deviceId) {
    res
      .status(400)
      .json({ error: `Missing required header: ${DEVICE_ID_HEADER}` });

    return;
  }

  // ✅ Validate format BEFORE proceeding
  if (!UUID_REGEX.test(deviceId)) {
    res.status(400).json({
      error: `Invalid ${DEVICE_ID_HEADER} format. Must be a valid UUID v4`,
    });

    return;
  }

  req.deviceId = deviceId;
  next();
};
