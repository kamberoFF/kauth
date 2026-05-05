import "dotenv/config";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import bcrypt from "bcrypt";
import { Role } from "../generated/prisma/client";

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

  for (const user of demoUsers) {
    const passwordHash = await bcrypt.hash(user.password, 10);

    await prisma.user.upsert({
      where: { email: user.email },
      update: {
        username: user.username,
        password: passwordHash,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
      },
      create: {
        email: user.email,
        username: user.username,
        password: passwordHash,
        first_name: user.first_name,
        last_name: user.last_name,
        role: user.role,
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
