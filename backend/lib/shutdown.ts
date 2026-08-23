import type { Server } from "node:http";
import { logger } from "./logger";

export interface GracefulShutdownOptions {
  server: Server;
  disconnect: () => Promise<void>;
  timeoutMs?: number;
  /** Injectable so tests can observe the outcome without killing the process. */
  exit?: (code: number) => void;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Stops accepting new connections, lets in-flight requests finish, then
 * disconnects the database — bounded by a force-exit timeout so one stuck
 * connection can't block cleanup long enough for an orchestrator's own
 * SIGKILL to arrive before the database gets a chance to disconnect.
 */
export function gracefulShutdown(
  signal: string,
  {
    server,
    disconnect,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    exit = process.exit,
  }: GracefulShutdownOptions,
) {
  logger.info("shutdown signal received", { signal });

  let settled = false;

  function finish(code: number) {
    if (settled) return;
    settled = true;
    clearTimeout(forceExit);

    disconnect()
      .then(() => logger.info("database disconnected", { signal }))
      .catch((error) =>
        logger.error("error disconnecting from database", { signal, error }),
      )
      .finally(() => exit(code));
  }

  const forceExit = setTimeout(() => {
    logger.error("shutdown did not drain in time, forcing exit", {
      signal,
      timeoutMs,
    });
    finish(1);
  }, timeoutMs);
  forceExit.unref?.();

  // Without this, keep-alive idle sockets can hold server.close()'s callback
  // open far longer than any in-flight request actually takes.
  server.closeIdleConnections?.();

  server.close(() => finish(0));
}
