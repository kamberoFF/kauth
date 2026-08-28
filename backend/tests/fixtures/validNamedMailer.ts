import type { Mailer } from "../../lib/mail";
import { logger } from "../../lib/logger";

/**
 * Fixture for `bootMailer` tests: a valid transport exposed as a named
 * `mailer` export, which `bootMailer` prefers over `default`.
 */
export const mailer: Mailer = {
  async send(mail) {
    logger.info("fixture:named transport received mail", { to: mail.to });
  },
};
