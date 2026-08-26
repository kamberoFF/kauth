export interface GenerateTokensParams {
  userId: string;
  familyId: string;
  sessionId: string;
  projectId: string;
  /**
   * Read from the user row at mint time. Rides along for consumers and
   * future offline verification (ADR 0007); kauth's own authorization never
   * reads this claim — requireAuth re-reads the row on every request.
   */
  role: "USER" | "ADMIN";
}

export interface AccessToken {
  userId: string;
  sessionId: string;
  jti: string;
  token: string;
}

export interface AccessTokenPayload {
  jti: string;
  familyId: string;
  userId: string;
  sid: string;
  projectId: string;
  role: "USER" | "ADMIN";
}

export interface RefreshToken {
  selector: string;
  verifier: string;
  token: string;
}
