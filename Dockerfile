# BUILD STAGE
FROM node:20-slim AS builder

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy dependency files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies for build)
RUN pnpm install --frozen-lockfile

# Copy prisma schema
COPY prisma ./prisma/

# Generate Prisma Client
RUN pnpm exec prisma generate

# Copy source code
COPY . .

# Build the application
RUN pnpm run build

# RUNNER STAGE
FROM node:20-slim AS runner

# Enable pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Copy built code and generated prisma client
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma

# If your app reads any non-TypeScript files at runtime — prompt templates,
# fonts, seed data — copy them here. `tsc` only emits .js, so anything tsc does
# not compile is absent from dist/ and the container fails at the first read.
# COPY --from=builder /app/assets ./assets

# Expose port (default 5000)
EXPOSE 5000

# Set production environment
ENV NODE_ENV=production

# Start the application
CMD ["pnpm", "start"]
