import path from "node:path";
import { pathToFileURL } from "node:url";
import config, { type NodeEnv } from "../config";
import { logger } from "./logger";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

/**
 * kauth does not pick an email provider for you. The default transport prints
 * to stdout so the local flows are complete and inspectable; a deployment
 * swaps in its own transport via MAILER_MODULE or setMailer at startup. This
 * is the one logger call site that deliberately includes a token: the printed
 * body *is* the delivery channel here, standing in for a real inbox, not an
 * observability log — a real transport delivers out-of-band and never logs
 * the body at all.
 */
export const consoleMailer: Mailer = {
  async send(mail) {
    logger.info("mail sent (dev console transport)", {
      to: mail.to,
      subject: mail.subject,
      body: mail.text,
    });
  },
};

export interface MemoryMailer extends Mailer {
  sent: Mail[];
  lastTo(address: string): Mail | undefined;
  clear(): void;
}

export function createMemoryMailer(): MemoryMailer {
  const sent: Mail[] = [];

  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
    lastTo(address) {
      return sent.filter((mail) => mail.to === address).at(-1);
    },
    clear() {
      sent.length = 0;
    },
  };
}

let mailer: Mailer = consoleMailer;

/**
 * Whether an explicit transport has been installed. Both the production
 * fail-fast in `bootMailer` and the dev one-time warning in `sendMail` read
 * this. Installing the built-in `consoleMailer` — even deliberately — does not
 * count as configuring a transport, which is also what lets a test reset to
 * the unconfigured state by calling `setMailer(consoleMailer)`.
 */
let mailerConfigured = false;
let consoleTransportWarned = false;

export function setMailer(next: Mailer) {
  mailer = next;
  mailerConfigured = next !== consoleMailer;
  consoleTransportWarned = false;
}

interface BootMailerOptions {
  /**
   * Injected rather than read from `config` at call time so the production
   * path is reachable in-process — the `gracefulShutdown` injected-deps idiom
   * (lib/shutdown.ts).
   */
  nodeEnv: NodeEnv;
  /**
   * Defaults to `config.mailer_module` so the caller and the production path
   * share one code path regardless of who invokes `bootMailer`.
   */
  modulePath?: string;
}

function hasSend(value: unknown): value is Mailer {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { send?: unknown }).send === "function"
  );
}

/**
 * Installs the operator's mail transport from `MAILER_MODULE` and enforces the
 * production posture: kauth ships only the dev console transport, which prints
 * verification links and reset tokens to stdout, so a production instance with
 * no explicitly configured transport refuses to boot rather than leak them to
 * its logs. Runs before migrations so a misconfigured transport aborts the
 * boot before any database work.
 */
export async function bootMailer({
  nodeEnv,
  modulePath = config.mailer_module,
}: BootMailerOptions): Promise<void> {
  if (modulePath) {
    const resolved = path.resolve(process.cwd(), modulePath);

    let loaded: Record<string, unknown>;
    try {
      loaded = (await import(pathToFileURL(resolved).href)) as Record<
        string,
        unknown
      >;
    } catch (error) {
      // Bun raises a ResolveMessage (not an Error subclass) for an unresolved
      // path, carrying code ERR_MODULE_NOT_FOUND; anything else is a module
      // that resolved but threw while evaluating.
      const code = (error as { code?: string } | null)?.code;
      const detail =
        code === "ERR_MODULE_NOT_FOUND"
          ? "no module found at that path"
          : `it failed to load: ${
              error instanceof Error ? error.message : String(error)
            }`;
      throw new Error(
        `MAILER_MODULE "${modulePath}" (resolved to "${resolved}") could not be used — ${detail}`,
        { cause: error },
      );
    }

    const transport = loaded.mailer ?? loaded.default;

    if (!hasSend(transport)) {
      throw new Error(
        `MAILER_MODULE at "${modulePath}" exports no valid Mailer — expected a named "mailer" export or a default export with a send(mail) method.`,
      );
    }

    setMailer(transport);
  }

  if (nodeEnv === "production" && !mailerConfigured) {
    throw new Error(
      "No mail transport is configured. Set MAILER_MODULE to a module exporting a " +
        'Mailer (a default export or a named "mailer" export); kauth ships no transport ' +
        "and will not run in production on the dev console transport. See " +
        "backend/README.md → Email.",
    );
  }
}

/**
 * Delivery failures must not decide whether an account action succeeded, so
 * callers treat sending as best-effort and the error surfaces in logs only.
 */
export async function sendMail(mail: Mail) {
  if (!mailerConfigured && !consoleTransportWarned) {
    consoleTransportWarned = true;
    logger.warn(
      "mail is going through the dev console transport, not a real delivery channel — set MAILER_MODULE for any non-local use",
    );
  }

  try {
    await mailer.send(mail);
  } catch (error) {
    logger.error("failed to send mail", { to: mail.to, error });
  }
}

export function verificationEmail(to: string, token: string): Mail {
  const link = `${config.frontend_url}/verify-email?token=${encodeURIComponent(token)}`;

  return {
    to,
    subject: "Confirm your email address",
    text: `Confirm your email address by opening this link:\n\n${link}\n\nThe link expires in 24 hours.`,
  };
}

/**
 * Sent to the existing account holder when someone tries to register their
 * address (ADR 0008). The register response is identical on both branches, so
 * this notice is the only signal the real user gets. It carries nothing
 * sensitive and nothing confirmable — no token, no username, no project name,
 * no "who tried" — just a pointer at signing in or resetting the password. A
 * bare sign-in link is fine: it discloses nothing.
 */
export function existingAccountEmail(to: string): Mail {
  const link = `${config.frontend_url}/login`;

  return {
    to,
    subject: "Someone tried to sign up with your email",
    text:
      `Someone just tried to create an account using this email address, but ` +
      `it already has one.\n\n` +
      `If that was you, you can sign in here:\n\n${link}\n\n` +
      `If you have forgotten your password, use the reset link on that page.\n\n` +
      `If it was not you, no new account was created and you can ignore this ` +
      `message.`,
  };
}

export function passwordResetEmail(to: string, token: string): Mail {
  const link = `${config.frontend_url}/reset-password?token=${encodeURIComponent(token)}`;

  return {
    to,
    subject: "Reset your password",
    text: `Reset your password by opening this link:\n\n${link}\n\nThe link expires in 1 hour. If you did not request this, you can ignore this email.`,
  };
}
