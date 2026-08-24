import config from "../config";
import { prisma } from "./prisma";

// Tuned once against the deployment class this service targets (2026-08):
// 128 MiB / t=3 measured ~320 ms per hash, inside the 250-400 ms window.
// Bun exposes no parallelism knob for argon2id; its internal default applies.
const ARGON2_OPTIONS = {
  algorithm: "argon2id" as const,
  memoryCost: 131_072,
  timeCost: 3,
};

let dummyHash: Promise<string> | undefined;

// A login against an unknown account must still pay the full hash cost, or
// response timing discloses whether the address exists. The dummy hash is
// built once, lazily; its input is arbitrary because no one ever sees it.
function getDummyHash() {
  dummyHash ??= Bun.password.hash("kauth-dummy-credential", ARGON2_OPTIONS);
  return dummyHash;
}

export function hashPassword(password: string) {
  return Bun.password.hash(password, ARGON2_OPTIONS);
}

// Always performs exactly one comparison, whatever the stored credential
// state, so unknown-account and bad-password responses cost the same.
export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined,
) {
  return Bun.password.verify(password, storedHash ?? (await getDummyHash()));
}

/**
 * The floor a password must clear in a given Project: the Project's own
 * override when set, otherwise the deployment-wide PASSWORD_MIN_LENGTH.
 */
export function minPasswordLength(policy: number | null | undefined) {
  return policy ?? config.password_min_length;
}

/**
 * Effective floor for a project id, looked up and resolved in one step —
 * the shape every set-password controller needs.
 */
export async function projectPasswordFloor(projectId: string) {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { min_password_length: true },
  });

  return minPasswordLength(project?.min_password_length);
}
