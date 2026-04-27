import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";

const JWT_SECRET = process.env.JWT_SECRET!;

export const generateTokens = (userId: string) => {
  const a_jwtid = uuidv4();
  const r_jwtid = uuidv4();
  const accessToken = jwt.sign({ userId }, JWT_SECRET, {
    jwtid: a_jwtid,
    expiresIn: "15m",
  });
  const refreshToken = jwt.sign({ userId }, JWT_SECRET, {
    jwtid: r_jwtid,
    expiresIn: "7d",
  });
  return { accessToken, refreshToken, a_jwtid, r_jwtid };
};

export const verifyAccessToken = (token: string) => {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      jti: string;
    };
    return { userId: payload.userId, jwtid: payload.jti };
  } catch {
    return null;
  }
};

export const verifyRefreshToken = (token: string) => {
  try {
    const payload = jwt.verify(token, JWT_SECRET) as {
      userId: string;
      jti: string;
    };
    return { userId: payload.userId, jwtid: payload.jti };
  } catch {
    return null;
  }
};
