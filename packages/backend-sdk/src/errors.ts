/**
 * The platform's error shape, surfaced directly rather than wrapped in a
 * generic error type — callers branch on `code`, per the platform contract.
 */
export class KauthError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "KauthError";
    this.code = code;
  }
}

/**
 * ADR 0003: the server advertises its contract version on every response and
 * an exact mismatch means this SDK predates (or postdates) the server. Because
 * detection happens via the *response* header, a mutating call may already
 * have completed server-side — the message must say so, and callers must not
 * auto-retry.
 */
export class ContractVersionMismatchError extends KauthError {
  constructor(serverVersion: string | null, expectedVersion: string) {
    super(
      "contract_version_mismatch",
      `kauth contract version mismatch: the server reported ${
        serverVersion ?? "no version"
      }, but this SDK was built against ${expectedVersion}. Redeploy the SDK alongside the kauth upgrade. If this was a mutating call, the operation may have already completed server-side and must not be automatically retried.`,
    );
    this.name = "ContractVersionMismatchError";
  }
}
