import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcrypt";
import { Role } from "../generated/prisma/client";
import { CREDENTIAL_PROVIDER } from "../constants/providers";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({
  adapter,
});

async function main() {
  const demoUsers = [
    {
      email: "admin@example.com",
      username: "admin",
      password: "password123",
      first_name: "Admin",
      last_name: "User",
      role: Role.ADMIN,
    },
    {
      email: "demo@example.com",
      username: "demo",
      password: "password123",
      first_name: "Demo",
      last_name: "User",
      role: Role.USER,
    },
  ] as const;

  for (const demo of demoUsers) {
    const passwordHash = await bcrypt.hash(demo.password, 10);
    const profile = {
      username: demo.username,
      first_name: demo.first_name,
      last_name: demo.last_name,
      role: demo.role,
      email_verified: true,
    };

    const user = await prisma.user.upsert({
      where: { email: demo.email },
      update: profile,
      create: { email: demo.email, ...profile },
    });

    await prisma.account.upsert({
      where: {
        user_id_provider_id: {
          user_id: user.id,
          provider_id: CREDENTIAL_PROVIDER,
        },
      },
      update: { password: passwordHash },
      create: {
        user_id: user.id,
        provider_id: CREDENTIAL_PROVIDER,
        account_id: user.id,
        password: passwordHash,
      },
    });
  }

  console.log("Seed data inserted!");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
