# syntax=docker/dockerfile:1
# Multi-stage build: development / builder / production (see docker-patterns.md).
# Consumer compose files build this with `target: development`.

# ---- base: shared deps + Claude CLI ----------------------------------------
FROM node:20-alpine AS base
RUN apk add --no-cache bash git
WORKDIR /app
# AI Gateway shells out to the Claude CLI
RUN npm install -g @anthropic-ai/claude-code
RUN mkdir -p /home/node/.claude && \
    echo '{}' > /home/node/.claude.json && \
    chown -R node:node /home/node/.claude /home/node/.claude.json
COPY package.json package-lock.json* ./

# ---- development: watch mode (src may also be volume-mounted) ---------------
FROM base AS development
ENV NODE_ENV=development
RUN npm install
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN chown -R node:node /app
USER node
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3005/health/live || exit 1
CMD ["npm", "run", "start:dev"]

# ---- builder: compile dist for production ----------------------------------
FROM base AS builder
RUN npm install
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN npx nest build

# ---- production: slim runtime ----------------------------------------------
FROM node:20-alpine AS production
RUN apk add --no-cache bash git
WORKDIR /app
ENV NODE_ENV=production
RUN npm install -g @anthropic-ai/claude-code
RUN mkdir -p /home/node/.claude && \
    echo '{}' > /home/node/.claude.json && \
    chown -R node:node /home/node/.claude /home/node/.claude.json
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist
RUN chown -R node:node /app
USER node
EXPOSE 3005
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3005/health/live || exit 1
CMD ["node", "dist/main"]
