import type { Server } from "node:http";
import app from "../../app";
import { prisma } from "../../lib/prisma";

export const TEST_DEVICE_ID = "3f1a2b4c-5d6e-4f80-9a1b-2c3d4e5f6071";

let server: Server | undefined;
let baseUrl = "";

export async function startTestServer() {
  server = await new Promise<Server>((resolve, reject) => {
    const instance = app.listen(0, () => resolve(instance));
    instance.on("error", reject);
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Test server did not bind to a TCP port");
  }

  baseUrl = `http://127.0.0.1:${address.port}`;

  return baseUrl;
}

export async function stopTestServer() {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }

  await prisma.$disconnect();
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

interface ApiOptions {
  body?: unknown;
  deviceId?: string | null;
  accessToken?: string;
  headers?: Record<string, string>;
  redirect?: "follow" | "manual" | "error";
}

export async function api<T = any>(
  method: string,
  path: string,
  options: ApiOptions = {},
): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...options.headers,
  };

  if (options.deviceId !== null) {
    headers["x-device-id"] = options.deviceId ?? TEST_DEVICE_ID;
  }

  if (options.accessToken) {
    headers["authorization"] = `Bearer ${options.accessToken}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    redirect: options.redirect,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  // Redirects carry Express's plain-text body, so parsing is conditional.
  const isJson = response.headers
    .get("content-type")
    ?.includes("application/json");

  return {
    status: response.status,
    body: isJson && text.length > 0 ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

/**
 * Truncating users cascades through every dependent table, which keeps this
 * from needing to know the full table list as the schema grows.
 */
export async function resetDatabase() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "users" RESTART IDENTITY CASCADE',
  );
}
