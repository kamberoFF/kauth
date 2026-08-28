/**
 * Fixture for `bootMailer` tests: a module that loads but exports nothing with
 * a `send` method, so the export-shape check must reject it.
 */
export default {
  deliver() {
    // wrong method name on purpose
  },
};
