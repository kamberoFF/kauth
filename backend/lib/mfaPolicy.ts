import type { Prisma } from "../generated/prisma/client";

/**
 * The mandate's window length resolves at each use site rather than being
 * materialized into the column: a null `mfa_grace_days` means "deployment
 * default", the same rule lib/passwords.ts uses for the password floor.
 */
export const MFA_GRACE_DAYS_DEFAULT = 7;

export function resolveMfaGraceDays(project: { mfa_grace_days: number | null }) {
  return project.mfa_grace_days ?? MFA_GRACE_DAYS_DEFAULT;
}

export function mfaGraceDeadline(days: number) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function stampWindow(days: number) {
  return { mfa_grace_ends_at: mfaGraceDeadline(days) };
}

/**
 * Activation backfill, run inside the PATCH transaction when `enforce_mfa`
 * flips on. Only users who have no window yet get one — an existing stamp is
 * a fact about an earlier mandate cycle, and rewriting it here would silently
 * reset deadlines people may already be racing.
 */
export async function backfillMfaGrace(
  tx: Prisma.TransactionClient,
  projectId: string,
  days: number,
) {
  await tx.user.updateMany({
    where: {
      project_id: projectId,
      mfa_enrolled_at: null,
      mfa_grace_ends_at: null,
    },
    data: stampWindow(days),
  });
}

/**
 * Per-user stamping at credential verification (register, login, OAuth
 * exchange). Idempotent by construction: the write only lands for an
 * unenrolled user with no window yet, so a concurrent sign-in can never
 * shorten a deadline someone is already working against. Returns the deadline
 * when one applies, so sign-in responses can surface it; null means the user
 * is enrolled or their project has no mandate and nothing was written.
 */
export async function stampMfaGrace(
  tx: Prisma.TransactionClient,
  user: { id: string; mfa_enrolled_at: Date | null },
  projectId: string,
): Promise<Date | null> {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: projectId },
    select: { enforce_mfa: true, mfa_grace_days: true },
  });

  if (!project.enforce_mfa || user.mfa_enrolled_at) {
    return null;
  }

  const endsAt = mfaGraceDeadline(resolveMfaGraceDays(project));

  const claimed = await tx.user.updateMany({
    where: {
      id: user.id,
      mfa_enrolled_at: null,
      mfa_grace_ends_at: null,
    },
    data: { mfa_grace_ends_at: endsAt },
  });

  if (claimed.count > 0) {
    return endsAt;
  }

  // Our candidate lost — a concurrent sign-in stamped first, or a window
  // already existed. Surface the stored window rather than the candidate, so
  // responses never advertise a deadline the row does not actually carry.
  const current = await tx.user.findUniqueOrThrow({
    where: { id: user.id },
    select: { mfa_enrolled_at: true, mfa_grace_ends_at: true },
  });

  return current.mfa_enrolled_at ? null : current.mfa_grace_ends_at;
}
