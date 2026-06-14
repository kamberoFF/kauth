import dotenv from "dotenv";

// Upgrade to use zod for validation in the future

dotenv.config();

export type NodeEnv = "development" | "production" | "test";

interface Config {
  port: number;
  node_env: NodeEnv;
  database_url: string;
  jwt_secret: string;
  cookie_secret: string;
  frontend_url: string;
}

function required(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`${name} is required`);
  }

  return value;
}

function getNodeEnv() {
  const value = process.env.NODE_ENV || "development";

  if (!["development", "production", "test"].includes(value)) {
    throw new Error(
      `Invalid NODE_ENV: ${value}. Expected development, production, or test.`,
    );
  }

  return value as NodeEnv;
}

const nodeEnv = getNodeEnv();

const config: Config = {
  port: Number(process.env.PORT) || 6767,
  node_env: nodeEnv,
  database_url:
    process.env.DATABASE_URL ||
    "postgresql://postgres:password@localhost:5433/kauth?schema=public",
  jwt_secret: required("JWT_SECRET"),
  cookie_secret: required("COOKIE_SECRET"),
  frontend_url: process.env.FRONTEND_URL || "http://localhost:5173",
};

export default config;
