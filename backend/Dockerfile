FROM oven/bun:1

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json bun.lockb* ./
RUN bun i

# Copy source + config
COPY . .

# Generate Prisma client
RUN bunx prisma generate

EXPOSE 6767

# Bun runs TypeScript natively
CMD ["bun", "run", "server.ts"]