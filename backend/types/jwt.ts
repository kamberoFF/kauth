export interface GenerateTokensParams {
  userId: string;
  familyId: string;
}

export interface AccessToken {
  userId: string;
  jti: string;
  token: string;
}

export interface RefreshToken {
  selector: string;
  verifier: string;
  token: string;
}
