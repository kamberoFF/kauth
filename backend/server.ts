import app from "./app";
import config from "./config";
import { prisma } from "./lib/prisma";
import { logger } from "./lib/logger";
import { gracefulShutdown } from "./lib/shutdown";
import { ensurePlatformProject } from "./lib/platformProject";
import { closeRateLimitRedis } from "./lib/rateLimitStore";
import { bootMailer } from "./lib/mail";

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

  // Both pipes must be drained concurrently: waiting on the exit code while a
  // full pipe buffer goes unread deadlocks boot on chatty output.
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`prisma migrate deploy failed:\n${stderr || stdout}`);
  }

  if (stdout.trim()) {
    logger.info("migrations applied", { output: stdout.trim() });
  }
}

async function main() {
  // First, before any DB work: a misconfigured transport must abort the boot
  // now, and production must not start on the console transport at all.
  await bootMailer({ nodeEnv: config.node_env });

  await applyMigrations();
  await ensurePlatformProject();

  const server = app.listen(config.port, () => {
    logger.info("server listening", { port: config.port });
  });

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () =>
      gracefulShutdown(signal, {
        server,
        disconnect: async () => {
          try {
            await prisma.$disconnect();
          } finally {
            closeRateLimitRedis();
          }
        },
        timeoutMs: config.shutdown_timeout_ms,
      }),
    );
  }
}

main().catch((error) => {
  logger.error("startup failed", { error });
  process.exit(1);
});
