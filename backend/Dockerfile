FROM oven/bun:1.3.14

WORKDIR /app

# Copy dependency manifests first for layer caching
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source + config
COPY . .

# Generate Prisma client
RUN bun run prisma:generate

# oven/bun already ships this user; everything above still runs as root so
# `bun install`/COPY/generate keep default permissions, and only the
# running process drops to it.
USER bun

EXPOSE 6767

# Hits the liveness endpoint — a wedged process fails this even though the
# container itself is still "up".
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:6767/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "run", "start"]