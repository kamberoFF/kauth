import config from "../config";

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
 * swaps in its own transport with setMailer at startup.
 */
export const consoleMailer: Mailer = {
  async send(mail) {
    console.log(
      `[mail] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`,
    );
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

export function setMailer(next: Mailer) {
  mailer = next;
}

/**
 * Delivery failures must not decide whether an account action succeeded, so
 * callers treat sending as best-effort and the error surfaces in logs only.
 */
export async function sendMail(mail: Mail) {
  try {
    await mailer.send(mail);
  } catch (error) {
    console.error(`[mail] failed to send to ${mail.to}`, error);
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

export function passwordResetEmail(to: string, token: string): Mail {
  const link = `${config.frontend_url}/reset-password?token=${encodeURIComponent(token)}`;

  return {
    to,
    subject: "Reset your password",
    text: `Reset your password by opening this link:\n\n${link}\n\nThe link expires in 1 hour. If you did not request this, you can ignore this email.`,
  };
}
