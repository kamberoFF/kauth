import dotenv from "dotenv";

dotenv.config();

interface Config {
  port: number;
  node_env: string;
  database_url: string;
  jwt_secret: string;
}

const config: Config = {
  port: Number(process.env.PORT) || 6767,
  node_env: process.env.NODE_ENV || "development",
  database_url:
    process.env.DATABASE_URL ||
    "postgresql://postgres:password@localhost:5433/kauth?schema=public",
  jwt_secret: process.env.JWT_SECRET!,
};

if (!config.jwt_secret) {
  throw new Error("JWT_SECRET is required");
}

export default config;
