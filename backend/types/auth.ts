import { type Request } from "express";

// Base augmented request with userId (after protect middleware)
export type AuthRequest = Request & {
  userId?: string;
};

// Request that requires x-device-id header (for login/register/refresh)
export type DeviceRequest = Request & {
  deviceId?: string; // Attached by validateDevice middleware
};

// Combined: auth + device (if you need both)
export type AuthDeviceRequest = AuthRequest & DeviceRequest;
