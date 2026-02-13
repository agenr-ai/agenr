FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS install
COPY package.json bun.lock ./
COPY packages/sdk/package.json ./packages/sdk/package.json
COPY packages/mcp/package.json ./packages/mcp/package.json
COPY packages/openclaw-skill/package.json ./packages/openclaw-skill/package.json
RUN bun install --frozen-lockfile --production

FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY src ./src
COPY packages ./packages
COPY data/interaction-profiles ./data/interaction-profiles
COPY data/adapters ./data/adapters
RUN mkdir -p ./data/runtime-adapters
COPY data/user-profile.example.json ./data/user-profile.example.json
COPY data/user-profile.staging.json ./data/user-profile.staging.json
COPY package.json tsconfig.json ./
RUN groupadd --system --gid 1001 agenr && \
    useradd --system --uid 1001 --gid 1001 --no-create-home agenr
RUN mkdir -p /app/data && chown -R agenr:agenr /app/data
USER agenr

ENV NODE_ENV=production
EXPOSE 3001
CMD ["bun", "src/index.ts"]
