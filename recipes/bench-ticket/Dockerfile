# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml ./
COPY . .
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
EXPOSE 8787
CMD ["pnpm", "exec", "tsx", "recipes/bench-ticket/host.ts"]
