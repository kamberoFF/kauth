/**
 * The one platform-owned Project every kauth deployment seeds at startup.
 * Developers register and log in here through the exact same endpoints any
 * other project's end users use, and it's the only Project a `POST /projects`
 * caller may be scoped to — kauth dogfoods its own auth stack instead of
 * running a second one. Deliberately distinct from `prisma/seed.ts`'s
 * `00000000-...-000000000000` "Seed Project" (unrelated local dev fixtures).
 */
export const PLATFORM_PROJECT_ID =
  "11111111-1111-4111-8111-111111111111" as const;

export const PLATFORM_PROJECT_NAME = "kauth Platform" as const;
