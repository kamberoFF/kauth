import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import path from "node:path";
import {
  bootMailer,
  consoleMailer,
  createMemoryMailer,
  sendMail,
  setMailer,
} from "../lib/mail";

const FIXTURES = path.join(import.meta.dir, "fixtures");
const fixture = (name: string) => path.join(FIXTURES, name);

const mail = {
  to: "boot@example.com",
  subject: "hello",
  text: "body",
};

/**
 * Same pattern as logging.test.ts: the logger always writes through
 * `console.log`, so patching it captures every level.
 */
async function captureLogs<T>(fn: () => Promise<T>) {
  const raw: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    raw.push(String(args[0]));
  };

  try {
    await fn();
  } finally {
    console.log = original;
  }

  return raw
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line !== null);
}

const isConsoleTransportWarning = (line: Record<string, unknown>) =>
  line.level === "warn" && String(line.msg).includes("console transport");

// Every case starts from the unconfigured console-transport state; installing
// the built-in consoleMailer is how mail.ts lets us reset `mailerConfigured`
// and the one-time-warning flag without re-importing the module.
beforeEach(() => {
  setMailer(consoleMailer);
});

// tests/setup.ts installs a memory mailer for the rest of the suite; restore it.
afterAll(() => {
  setMailer(createMemoryMailer());
});

describe("bootMailer — no MAILER_MODULE", () => {
  it("does not throw in development and leaves the console transport routing", async () => {
    await bootMailer({ nodeEnv: "development" });

    const lines = await captureLogs(() => sendMail(mail));
    expect(
      lines.some((l) => l.msg === "mail sent (dev console transport)"),
    ).toBe(true);
  });

  it("does not throw in test", async () => {
    await expect(bootMailer({ nodeEnv: "test" })).resolves.toBeUndefined();
  });

  it("throws in production, naming MAILER_MODULE", async () => {
    // Mutation check: delete the `nodeEnv === "production" && !mailerConfigured`
    // block in bootMailer and this expectation fails.
    await expect(bootMailer({ nodeEnv: "production" })).rejects.toThrow(
      /MAILER_MODULE/,
    );
  });
});

describe("bootMailer — MAILER_MODULE points at a valid transport", () => {
  it("installs a default-export Mailer and routes sendMail to it", async () => {
    await bootMailer({
      nodeEnv: "development",
      modulePath: fixture("validDefaultMailer.ts"),
    });

    const lines = await captureLogs(() => sendMail(mail));
    expect(
      lines.some((l) => l.msg === "fixture:default transport received mail"),
    ).toBe(true);
  });

  it("installs a named `mailer` export", async () => {
    await bootMailer({
      nodeEnv: "development",
      modulePath: fixture("validNamedMailer.ts"),
    });

    const lines = await captureLogs(() => sendMail(mail));
    expect(
      lines.some((l) => l.msg === "fixture:named transport received mail"),
    ).toBe(true);
  });

  it("satisfies the production guard", async () => {
    await expect(
      bootMailer({
        nodeEnv: "production",
        modulePath: fixture("validNamedMailer.ts"),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("bootMailer — MAILER_MODULE is broken", () => {
  it("throws when the path does not resolve, naming the path and the failure", async () => {
    const bad = fixture("noSuchMailer.ts");

    await expect(
      bootMailer({ nodeEnv: "development", modulePath: bad }),
    ).rejects.toThrow(
      new RegExp(`MAILER_MODULE[\\s\\S]*noSuchMailer\\.ts[\\s\\S]*no module found`),
    );
  });

  it("throws when the module exports no valid Mailer", async () => {
    await expect(
      bootMailer({
        nodeEnv: "development",
        modulePath: fixture("invalidMailer.ts"),
      }),
    ).rejects.toThrow(/MAILER_MODULE[\s\S]*no valid Mailer/);
  });
});

describe("dev console-transport one-time warning", () => {
  it("warns exactly once across two sends on the console transport", async () => {
    const lines = await captureLogs(async () => {
      await sendMail(mail);
      await sendMail(mail);
    });

    expect(lines.filter(isConsoleTransportWarning)).toHaveLength(1);
  });

  it("does not warn once a real transport is installed", async () => {
    await bootMailer({
      nodeEnv: "development",
      modulePath: fixture("validNamedMailer.ts"),
    });

    const lines = await captureLogs(async () => {
      await sendMail(mail);
      await sendMail(mail);
    });

    expect(lines.some(isConsoleTransportWarning)).toBe(false);
  });
});
