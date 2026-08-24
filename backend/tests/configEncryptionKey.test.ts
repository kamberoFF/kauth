import { describe, expect, it } from "bun:test";
import path from "node:path";

/**
 * config.ts validates at import time and throws, so each case runs in a
 * child process with a controlled ENCRYPTION_KEY. Even the "missing" case
 * sets a value (empty string) because dotenv would otherwise load one from
 * backend/.env — it skips keys already present in the environment.
 */
const VALID_HEX = "a".repeat(64);
const VALID_BASE64 = Buffer.from(new Uint8Array(32).fill(7)).toString("base64");

function runConfigWith(encryptionKey: string | undefined) {
  const env: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }

  env.ENCRYPTION_KEY = encryptionKey ?? "";

  return Bun.spawnSync(["bun", "-e", 'await import("./config"); console.log("CONFIG_OK")'], {
    cwd: path.resolve(import.meta.dir, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

describe("ENCRYPTION_KEY configuration", () => {
  it("fails startup fast when missing", () => {
    const proc = runConfigWith(undefined);

    expect(proc.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(proc.stderr)).toMatch(/ENCRYPTION_KEY/);
  });

  it("fails startup fast on a short key", () => {
    // 16 bytes of hex entropy — well-formed but under the 32-byte floor.
    const proc = runConfigWith("a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4");

    expect(proc.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(proc.stderr)).toMatch(/ENCRYPTION_KEY/);
  });

  it("fails startup fast on non-hex non-base64 junk", () => {
    const proc = runConfigWith("!not-encodable!".repeat(8));

    expect(proc.exitCode).not.toBe(0);
    expect(new TextDecoder().decode(proc.stderr)).toMatch(/ENCRYPTION_KEY/);
  });

  it("accepts a 32-byte hex key", () => {
    const proc = runConfigWith(VALID_HEX);

    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain("CONFIG_OK");
  });

  it("accepts a 32-byte base64 key", () => {
    const proc = runConfigWith(VALID_BASE64);

    expect(proc.exitCode).toBe(0);
    expect(new TextDecoder().decode(proc.stdout)).toContain("CONFIG_OK");
  });
});
