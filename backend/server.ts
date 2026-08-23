import app from "./app";
import config from "./config";
import { prisma } from "./lib/prisma";
import { logger } from "./lib/logger";
import { gracefulShutdown } from "./lib/shutdown";
import { ensurePlatformProject } from "./lib/platformProject";

/**
 * Concurrent replicas serialize on Prisma's own Postgres advisory lock during
 * `migrate deploy` (a non-configurable ~10s wait) — fine at kauth's current
 * migration count, and simpler than adding our own coordination.
 */
async function applyMigrations() {
  const proc = Bun.spawn(["bunx", "--bun", "prisma", "migrate", "deploy"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const output = await new Response(proc.stderr).text();
    throw new Error(`prisma migrate deploy failed:\n${output}`);
  }
}

async function main() {
  await applyMigrations();
  await ensurePlatformProject();

  const server = app.listen(config.port, () => {
    logger.info("server listening", { port: config.port });
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () =>
      gracefulShutdown(signal, {
        server,
        disconnect: () => prisma.$disconnect(),
        timeoutMs: config.shutdown_timeout_ms,
      }),
    );
  }
}

main().catch((error) => {
  logger.error("startup failed", { error });
  process.exit(1);
});
