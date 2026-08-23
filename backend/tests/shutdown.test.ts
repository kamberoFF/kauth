import { describe, expect, it } from "bun:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { gracefulShutdown } from "../lib/shutdown";

async function startSlowServer(delayMs: number) {
  const app = express();
  app.get("/slow", async (_req, res) => {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.json({ ok: true });
  });

  const server = await new Promise<Server>((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });

  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitUntil(predicate: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition not met in time");
}

describe("gracefulShutdown", () => {
  it("drains the in-flight request, disconnects, and exits cleanly", async () => {
    const { server, baseUrl } = await startSlowServer(150);
    const requestPromise = fetch(`${baseUrl}/slow`);
    // Let the request actually reach the handler before shutdown starts.
    await new Promise((resolve) => setTimeout(resolve, 20));

    let disconnected = false;
    let exitCode: number | undefined;

    gracefulShutdown("SIGTERM", {
      server,
      disconnect: async () => {
        disconnected = true;
      },
      timeoutMs: 2000,
      exit: (code) => {
        exitCode = code;
      },
    });

    const response = await requestPromise;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });

    await waitUntil(() => exitCode !== undefined, 1000);
    expect(exitCode).toBe(0);
    expect(disconnected).toBe(true);
  });

  it("force-exits once the timeout elapses, but still disconnects first", async () => {
    const { server, baseUrl } = await startSlowServer(5000);
    void fetch(`${baseUrl}/slow`).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 20));

    let disconnected = false;
    let exitCode: number | undefined;

    gracefulShutdown("SIGTERM", {
      server,
      disconnect: async () => {
        disconnected = true;
      },
      timeoutMs: 100,
      exit: (code) => {
        exitCode = code;
      },
    });

    await waitUntil(() => exitCode !== undefined, 1000);
    expect(exitCode).toBe(1);
    expect(disconnected).toBe(true);

    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
