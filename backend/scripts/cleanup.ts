import { prisma } from "../lib/prisma";
import config from "../config";
import { logger } from "../lib/logger";

function daysAgo(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Discrete, operator-triggered maintenance (`bun run cleanup`) rather than an
 * in-process timer — cadence is the operator's choice, and the always-on
 * server process stays simple. Order matters and is not an implementation
 * detail: see docs/adr/0004-coordinated-session-audit-retention.md.
 */
export async function runCleanup() {
  const refreshCutoff = daysAgo(config.cleanup_retention_days);
  const auditCutoff = daysAgo(config.audit_retention_days);

  // 1. Refresh tokens with no ongoing value: consumed, or expired by clock
  // regardless of their stored status — expiry is only ever written lazily,
  // when a client actually tries to use an already-expired token (see
  // controllers/auth.ts), so most simply time out with `status` still
  // ACTIVE. Revoked tokens are deliberately excluded: they ride along with
  // their session's own coordinated deletion in step 3 below.
  const refreshTokens = await prisma.refreshToken.deleteMany({
    where: {
      status: { not: "REVOKED" },
      OR: [
        { status: "CONSUMED", consumed_at: { lt: refreshCutoff } },
        { expires_at: { lt: refreshCutoff } },
      ],
    },
  });

  // 2. Audit events past their own retention window.
  const securityEvents = await prisma.securityEvent.deleteMany({
    where: { created_at: { lt: auditCutoff } },
  });

  // 3. Sessions that are done (revoked long enough ago, or expired by
  // status or by clock) AND no longer referenced by any surviving audit
  // event. The `securityEvents: none` half is the actual guarantee — a
  // session revoked long ago can still have a recent event pointing at it,
  // and `SecurityEvent.session` uses onDelete: SetNull, so deleting the
  // session first would silently sever a still-live audit reference. This
  // must run after step 2: only once step 2 has cleared every event outside
  // retention does "no remaining reference" mean what it's supposed to.
  const sessions = await prisma.session.deleteMany({
    where: {
      OR: [
        { status: "REVOKED", revoked_at: { lt: auditCutoff } },
        { expires_at: { lt: auditCutoff } },
      ],
      securityEvents: { none: {} },
    },
  });

  const summary = {
    refreshTokensDeleted: refreshTokens.count,
    securityEventsDeleted: securityEvents.count,
    sessionsDeleted: sessions.count,
  };

  logger.info("cleanup run complete", summary);

  return summary;
}

if (import.meta.main) {
  runCleanup()
    .catch((error) => {
      logger.error("cleanup run failed", { error });
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
