import type { Mailer } from "../../lib/mail";
import { logger } from "../../lib/logger";

/**
 * Fixture for `bootMailer` tests: a valid transport exposed as the module's
 * `default` export. It records receipt through the logger so a test can
 * observe routing via `captureLogs`, independent of module identity.
 */
const mailer: Mailer = {
  async send(mail) {
    logger.info("fixture:default transport received mail", { to: mail.to });
  },
};

export default mailer;
