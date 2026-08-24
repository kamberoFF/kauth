import { describe, expect, it } from "bun:test";
import { prisma } from "../lib/prisma";

/**
 * Asserts database shape directly rather than through startTestServer/api():
 * what is being guarded is the migrated schema itself, not HTTP behavior,
 * so no server or per-test reset is involved.
 */
describe("schema hygiene", () => {
  it("has dropped the dead csrf_tokens table", async () => {
    const rows = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'csrf_tokens'
    `;

    expect(rows).toHaveLength(0);
  });

  it("keeps every csrf_tokens reference out of the Prisma schema", async () => {
    const schema = await Bun.file(
      new URL("../prisma/schema.prisma", import.meta.url),
    ).text();

    expect(schema).not.toContain("model CsrfToken");
    expect(schema).not.toContain("csrf_tokens");
  });
});
