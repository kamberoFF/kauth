import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import config from "../config";
import type {
  AccessToken,
  GenerateTokensParams,
  RefreshToken,
} from "../types/jwt";

const JWT_SECRET = config.jwt_secret;

export const generateTokens = ({
  userId,
  familyId,
}: GenerateTokensParams): {
  familyId: string;
  accessToken: AccessToken;
  refreshToken: RefreshToken;
} => {
  const jwtid = crypto.randomUUID();

  const accessToken = jwt.sign({ userId, familyId }, JWT_SECRET, {
    jwtid,
    expiresIn: "15m",
  });

  const selector = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");

  const refreshToken = `${selector}.${verifier}`;

  return {
    familyId,
    accessToken: { userId, jti: jwtid, token: accessToken },
    refreshToken: { selector, verifier, token: refreshToken },
  };
};

export const parseRefreshToken = (token: string): RefreshToken | null => {
  const [selector, verifier, ...rest] = token.split(".");

  if (!selector || !verifier || rest.length > 0) {
    return null;
  }

  return {
    selector,
    verifier,
    token,
  };
};

export const verifyAccessToken = (token: string) => {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      jti: string;
      familyId: string;
      userId: string;
    };

    return payload;
  } catch {
    return null;
  }
};
