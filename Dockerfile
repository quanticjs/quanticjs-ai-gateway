FROM node:20-alpine

RUN apk add --no-cache bash git

WORKDIR /app

# Install Claude CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create minimal Claude config for the node user
RUN mkdir -p /home/node/.claude && \
    echo '{}' > /home/node/.claude.json && \
    chown -R node:node /home/node/.claude /home/node/.claude.json

# Copy package files
COPY package.json package-lock.json* ./

RUN npm install

# Copy source & config
COPY src ./src
COPY tsconfig.json nest-cli.json ./

# Build
RUN npx nest build

# Ensure node user owns the app directory
RUN chown -R node:node /app

USER node

EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3005/health/live || exit 1

CMD ["node", "dist/main"]
