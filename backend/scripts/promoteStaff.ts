import { prisma } from "../lib/prisma";
import { recordSecurityEvent } from "../lib/securityEvents";
import { PLATFORM_PROJECT_ID } from "../constants/platform";

/**
 * Bootstrap for the first platform staff member (rbac ticket 02): nothing
 * sets roles over HTTP until one staff member exists, so the operator runs
 *
 *   bun scripts/promoteStaff.ts --email dev@example.com
 *
 * against a user who has already registered into the reserved platform
 * Project through the normal endpoints. Idempotent: promoting an existing
 * admin succeeds without touching the row. Exit code is non-zero when the
 * email is absent or the arguments are wrong, so deploy automation notices.
 */
async function main() {
  const emailArg = process.argv.indexOf("--email");
  const email = emailArg >= 0 ? process.argv[emailArg + 1] : undefined;

  if (!email) {
    console.error("Usage: bun scripts/promoteStaff.ts --email <address>");
    process.exit(1);
  }

  const user = await prisma.user.findFirst({
    where: { email, project_id: PLATFORM_PROJECT_ID },
    select: { id: true, role: true },
  });

  if (!user) {
    console.error(
      `No user "${email}" in the platform project (${PLATFORM_PROJECT_ID}). ` +
        "Register through POST /register with x-project-id first.",
    );
    process.exit(1);
  }

  if (user.role === "ADMIN") {
    console.log(`${email} is already platform staff; nothing to do.`);
    return;
  }

  // A role grant is an auth-relevant transition wherever it happens, so the
  // script writes the same ROLE_CHANGED event the HTTP endpoint does — with
  // no request context, and actor_user_id null because there is no session.
  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: { role: "ADMIN" },
    });

    await recordSecurityEvent(
      {
        type: "ROLE_CHANGED",
        userId: user.id,
        projectId: PLATFORM_PROJECT_ID,
        metadata: {
          old_role: user.role,
          new_role: "ADMIN",
          actor_user_id: null,
          via: "bootstrap_script",
        },
      },
      tx,
    );
  });

  console.log(`${email} promoted to platform staff (role ADMIN).`);
}

main()
  .catch((error) => {
    console.error("promoteStaff failed:", error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
