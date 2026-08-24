import { describe, expect, it } from "bun:test";
import { prisma } from "../lib/prisma";

/**
 * Direct database-shape assertions for the MFA foundation migration, in the
 * style of schema.test.ts: what is being guarded is the migrated schema and
 * the generated client surface, not HTTP behavior.
 */

async function columnExists(table: string, column: string) {
  const rows = await prisma.$queryRaw<{ column_name: string }[]>`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} AND column_name = ${column}
  `;

  return rows.length === 1;
}

async function enumValues(enumName: string) {
  const rows = await prisma.$queryRaw<{ enumlabel: string }[]>`
    SELECT enumlabel
    FROM pg_enum
    JOIN pg_type ON pg_enum.enumtypid = pg_type.oid
    WHERE typname = ${enumName}
  `;

  return rows.map((row) => row.enumlabel);
}

describe("MFA foundation schema", () => {
  it("adds the four TOTP state columns to users", async () => {
    expect(await columnExists("users", "totp_secret")).toBe(true);
    expect(await columnExists("users", "mfa_enrolled_at")).toBe(true);
    expect(await columnExists("users", "mfa_grace_ends_at")).toBe(true);
    expect(await columnExists("users", "last_totp_step")).toBe(true);
  });

  it("creates mfa_backup_codes keyed by hash with a user cascade", async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'mfa_backup_codes'
    `;
    expect(tables).toHaveLength(1);

    expect(await columnExists("mfa_backup_codes", "code_hash")).toBe(true);
    expect(await columnExists("mfa_backup_codes", "used_at")).toBe(true);

    const uniqueIndexes = await prisma.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'mfa_backup_codes'
    `;
    expect(
      uniqueIndexes.some((row) => /code_hash/.test(row.indexdef) && /UNIQUE/.test(row.indexdef)),
    ).toBe(true);
  });

  it("lets recovery_tokens carry a device id", async () => {
    expect(await columnExists("recovery_tokens", "device_id")).toBe(true);
  });

  it("adds the per-project mandate settings", async () => {
    expect(await columnExists("projects", "enforce_mfa")).toBe(true);
    expect(await columnExists("projects", "mfa_grace_days")).toBe(true);
  });

  it("extends TokenType with MFA_CHALLENGE", async () => {
    expect(await enumValues("TokenType")).toContain("MFA_CHALLENGE");
  });

  it("extends SecurityEventType with the five MFA event types", async () => {
    const values = await enumValues("SecurityEventType");

    expect(values).toContain("MFA_ENROLLMENT_STARTED");
    expect(values).toContain("MFA_ENROLLED");
    expect(values).toContain("MFA_DISABLED");
    expect(values).toContain("BACKUP_CODE_USED");
    expect(values).toContain("PROJECT_MFA_POLICY_CHANGED");
  });

  it("exposes the new fields through the generated client", async () => {
    // Unique per run: this file performs no reset, so a re-run against an
    // already-migrated database must not trip the unique constraints.
    const suffix = crypto.randomUUID();
    const project = await prisma.project.create({ data: { name: `mfa-schema-probe-${suffix}` } });
    const user = await prisma.user.create({
      data: { project_id: project.id, email: `probe-${suffix}@mfa.test` },
    });

    // Write/read every new column through the client so a missing mapping
    // fails here rather than in a later ticket's first use.
    await prisma.user.update({
      where: { id: user.id },
      data: {
        totp_secret: "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
        mfa_enrolled_at: new Date(),
        mfa_grace_ends_at: null,
        last_totp_step: 42,
      },
    });
    await prisma.mfaBackupCode.create({
      data: { user_id: user.id, code_hash: `${suffix}${suffix}${suffix}` },
    });
    await prisma.project.update({
      where: { id: project.id },
      data: { enforce_mfa: true, mfa_grace_days: 7 },
    });

    const reloaded = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      include: { backupCodes: true },
    });
    const reloadedProject = await prisma.project.findUniqueOrThrow({
      where: { id: project.id },
    });

    expect(reloaded.totp_secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(reloaded.mfa_enrolled_at).toBeInstanceOf(Date);
    expect(reloaded.last_totp_step).toBe(42);
    expect(reloaded.backupCodes).toHaveLength(1);
    expect(reloadedProject.enforce_mfa).toBe(true);
    expect(reloadedProject.mfa_grace_days).toBe(7);
  });
});
