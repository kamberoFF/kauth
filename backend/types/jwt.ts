export interface GenerateTokensParams {
  userId: string;
  familyId: string;
  sessionId: string;
  projectId: string;
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
}

export interface RefreshToken {
  selector: string;
  verifier: string;
  token: string;
}
