import dotenv from "dotenv";
import { z } from "zod";
import { version as packageVersion } from "./package.json";

dotenv.config();

export type NodeEnv = "development" | "production" | "test";

const MIN_SECRET_LENGTH = 32;

/**
 * Secrets are only length-enforced in production so that local dev and CI can
 * run with throwaway values, while a real deployment cannot start with a weak
 * HS256 key.
 */
function secret(name: string) {
  return z.string().min(1, `${name} is required`);
}

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(6767),
  NODE_ENV: z
    .enum(["development", "production", "test"])
    .default("development"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  JWT_SECRET: secret("JWT_SECRET"),
  COOKIE_SECRET: secret("COOKIE_SECRET"),
  FRONTEND_URL: z.url().default("http://localhost:5173"),
  APP_URL: z.url().default("http://localhost:6767"),
  /**
   * Number of reverse proxies in front of the app, or "false" when exposed
   * directly. Wrong values here silently corrupt req.ip, which both the audit
   * log and the IP rate limiters depend on.
   */
  TRUST_PROXY: z
    .union([z.coerce.number().int().min(0), z.literal("false")])
    .default("false"),
  /**
   * When on, a credential login is refused until the address is confirmed.
   * Off by default because turning it on without a working mail transport
   * locks everyone out.
   */
  REQUIRE_EMAIL_VERIFICATION: z
    .stringbool()
    .default(false),
  /**
   * Comma-separated origins allowed to make state-changing requests. Defaults
   * to the frontend and the service's own origin.
   */
  TRUSTED_ORIGINS: z.string().optional(),

  /**
   * Social providers are enabled only when both halves of their credential
   * pair are present, so an unconfigured provider 404s instead of failing
   * halfway through a redirect.
   */
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /**
   * How long a session may sit unused before it stops counting as live, even
   * though its sliding expiry has not run out. last_used_at is written on
   * refresh; an idle session simply stops refreshing and is reclaimed by the
   * cleanup job once its frozen expiry passes retention.
   */
  SESSION_INACTIVITY_DAYS: z.coerce.number().int().positive().default(14),

  /**
   * Bounded wait for in-flight requests to drain on SIGTERM/SIGINT before the
   * process force-exits. A stuck connection must not be able to block
   * `prisma.$disconnect()` long enough that an orchestrator's own SIGKILL
   * arrives first.
   */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * Governs the cleanup job (`bun run cleanup`). Kept independent of
   * AUDIT_RETENTION_DAYS deliberately: clearing out stale refresh-token
   * rotation debris and preserving audit/session history are different
   * concerns operators may want on very different timelines.
   */
  CLEANUP_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  /**
   * Governs SecurityEvent retention, and — coordinated, see
   * docs/adr/0004-coordinated-session-audit-retention.md — how long a
   * revoked/expired Session survives after nothing still references it.
   */
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  throw new Error(`Invalid environment configuration:\n${issues}`);
}

const env = parsed.data;

if (env.NODE_ENV === "production") {
  for (const name of ["JWT_SECRET", "COOKIE_SECRET"] as const) {
    if (env[name].length < MIN_SECRET_LENGTH) {
      throw new Error(
        `${name} must be at least ${MIN_SECRET_LENGTH} characters in production`,
      );
    }
  }
}

function trustedOrigins() {
  const configured = env.TRUSTED_ORIGINS?.split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const origins = configured?.length
    ? configured
    : [env.FRONTEND_URL, env.APP_URL];

  // Compared against the Origin header, which is a bare scheme://host[:port].
  return origins.map((origin) => new URL(origin).origin);
}

function credentialPair(clientId: string | undefined, clientSecret: string | undefined) {
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

const config = {
  port: env.PORT,
  node_env: env.NODE_ENV as NodeEnv,
  database_url: env.DATABASE_URL,
  jwt_secret: env.JWT_SECRET,
  cookie_secret: env.COOKIE_SECRET,
  frontend_url: env.FRONTEND_URL,
  app_url: env.APP_URL,
  trust_proxy: env.TRUST_PROXY === "false" ? false : env.TRUST_PROXY,
  require_email_verification: env.REQUIRE_EMAIL_VERIFICATION,
  trusted_origins: trustedOrigins(),
  oauth: {
    google: credentialPair(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET),
    github: credentialPair(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET),
  },
  log_level: env.LOG_LEVEL,
  session_inactivity_days: env.SESSION_INACTIVITY_DAYS,
  shutdown_timeout_ms: env.SHUTDOWN_TIMEOUT_MS,
  cleanup_retention_days: env.CLEANUP_RETENTION_DAYS,
  audit_retention_days: env.AUDIT_RETENTION_DAYS,
  /**
   * ADR 0003: the contract version is kauth's own release version, not a
   * parallel numbering scheme. Read from package.json so a release that
   * forgets to reason about shapes still changes what SDKs see.
   */
  contract_version: packageVersion,
} as const;

export default config;
