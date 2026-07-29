FROM oven/bun:1.3.14

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source + config
COPY . .

# Generate Prisma client
RUN bun run prisma:generate

EXPOSE 6767

CMD ["bun", "run", "start"]