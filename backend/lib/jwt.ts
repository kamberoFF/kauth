import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import config from "../config";
import type {
  AccessToken,
  AccessTokenPayload,
  GenerateTokensParams,
  RefreshToken,
} from "../types/jwt";

const JWT_SECRET = config.jwt_secret;
const JWT_ALGORITHM = "HS256";

export const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;

export const generateTokens = ({
  userId,
  familyId,
  sessionId,
  projectId,
}: GenerateTokensParams): {
  familyId: string;
  accessToken: AccessToken;
  refreshToken: RefreshToken;
} => {
  const jwtid = crypto.randomUUID();

  const accessToken = jwt.sign(
    { userId, familyId, sid: sessionId, projectId },
    JWT_SECRET,
    {
      algorithm: JWT_ALGORITHM,
      jwtid,
      expiresIn: ACCESS_TOKEN_TTL_MS / 1000,
    },
  );

  const selector = crypto.randomBytes(16).toString("base64url");
  const verifier = crypto.randomBytes(32).toString("base64url");

  const refreshToken = `${selector}.${verifier}`;

  return {
    familyId,
    accessToken: { userId, sessionId, jti: jwtid, token: accessToken },
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

/**
 * The algorithm is pinned rather than taken from the token header, so a token
 * claiming `alg: none` cannot walk straight past verification.
 *
 * A payload without `sid` predates session-bound access tokens and is refused:
 * it cannot be checked against a session, which is the whole point of the claim.
 */
export const verifyAccessToken = (token: string): AccessTokenPayload | null => {
  try {
    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: [JWT_ALGORITHM],
    }) as Partial<AccessTokenPayload>;

    if (
      !payload.sid ||
      !payload.userId ||
      !payload.familyId ||
      !payload.jti ||
      !payload.projectId
    ) {
      return null;
    }

    return payload as AccessTokenPayload;
  } catch {
    return null;
  }
};
