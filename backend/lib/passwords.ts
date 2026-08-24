import bcrypt from "bcrypt";

const PASSWORD_HASH_ROUNDS = 10;

let dummyHash: Promise<string> | undefined;

// A login against an unknown account must still pay the full hash cost, or
// response timing discloses whether the address exists. The dummy hash is
// built once, lazily; its input is arbitrary because no one ever sees it.
function getDummyHash() {
  dummyHash ??= bcrypt.hash("kauth-dummy-credential", PASSWORD_HASH_ROUNDS);
  return dummyHash;
}

export function hashPassword(password: string) {
  return bcrypt.hash(password, PASSWORD_HASH_ROUNDS);
}

// Always performs exactly one comparison, whatever the stored credential
// state, so unknown-account and bad-password responses cost the same.
export async function verifyPassword(
  password: string,
  storedHash: string | null | undefined,
) {
  return bcrypt.compare(password, storedHash ?? (await getDummyHash()));
}
