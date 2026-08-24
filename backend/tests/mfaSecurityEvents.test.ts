import { beforeEach, describe, expect, it } from "bun:test";
import type { SecurityEventSeverity, SecurityEventType } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma";
import { recordSecurityEvent } from "../lib/securityEvents";
import { resetDatabase } from "./helpers/api";

/**
 * Severity belongs to the event type (lib/securityEvents.ts), never the call
 * site. These write through the public API and read back what actually
 * landed, so a missing map entry — which would crash recordSecurityEvent or
 * fall back wrongly — surfaces here rather than in a later ticket.
 */
const EXPECTED_SEVERITIES: Record<string, SecurityEventSeverity> = {
  MFA_ENROLLMENT_STARTED: "INFO",
  MFA_ENROLLED: "WARNING",
  MFA_DISABLED: "WARNING",
  BACKUP_CODE_USED: "WARNING",
  PROJECT_MFA_POLICY_CHANGED: "WARNING",
};

describe("MFA security-event severities", () => {
  beforeEach(resetDatabase);

  // Mutation check (named, per repo convention): map MFA_ENROLLED to INFO in
  // lib/securityEvents.ts and this test goes red.
  it("derives the documented severity for each new MFA event type", async () => {
    const project = await prisma.project.create({ data: { name: "mfa-events" } });
    const user = await prisma.user.create({
      data: { project_id: project.id, email: `events-${crypto.randomUUID()}@mfa.test` },
    });

    for (const [type, severity] of Object.entries(EXPECTED_SEVERITIES)) {
      // No per-call severity: derivation must come from the static map.
      await recordSecurityEvent({
        type: type as SecurityEventType,
        userId: user.id,
        projectId: project.id,
      });

      const event = await prisma.securityEvent.findFirstOrThrow({
        where: { user_id: user.id, event_type: type as SecurityEventType },
      });

      expect(event.severity).toBe(severity);
    }
  });
});
