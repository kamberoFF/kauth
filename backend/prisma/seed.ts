import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Role } from "../generated/prisma/client";
import { CREDENTIAL_PROVIDER } from "../constants/providers";
import { hashPassword } from "../lib/passwords";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

const prisma = new PrismaClient({
  adapter,
});

async function main() {
  const project = await prisma.project.upsert({
    where: { id: "00000000-0000-4000-8000-000000000000" },
    update: {},
    create: {
      id: "00000000-0000-4000-8000-000000000000",
      name: "Seed Project",
    },
  });

  const demoUsers = [
    {
      email: "admin@example.com",
      username: "admin",
      password: "change-me-in-dev-only",
      first_name: "Admin",
      last_name: "User",
      role: Role.ADMIN,
    },
    {
      email: "demo@example.com",
      username: "demo",
      password: "change-me-in-dev-only",
      first_name: "Demo",
      last_name: "User",
      role: Role.USER,
    },
  ] as const;

  for (const demo of demoUsers) {
    const passwordHash = await hashPassword(demo.password);
    const profile = {
      username: demo.username,
      first_name: demo.first_name,
      last_name: demo.last_name,
      role: demo.role,
      email_verified: true,
    };

    const user = await prisma.user.upsert({
      where: {
        project_id_email: { project_id: project.id, email: demo.email },
      },
      update: profile,
      create: { project_id: project.id, email: demo.email, ...profile },
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
        project_id: project.id,
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
