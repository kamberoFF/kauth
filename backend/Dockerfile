FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable && corepack prepare yarn@1.22.22 --activate

# Copy dependency manifests first for layer caching
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Copy source + config
COPY . .

# Generate Prisma client
RUN yarn run prisma:generate

EXPOSE 6767

CMD ["yarn", "start"]