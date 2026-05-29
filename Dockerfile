FROM node:20-alpine

# Install bash (Claude CLI needs a POSIX shell)
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

# Copy source
COPY src ./src
COPY tsconfig.json ./

# Build
RUN npx tsc

# Ensure node user owns the app directory
RUN chown -R node:node /app

EXPOSE 3005

CMD ["node", "dist/server.js"]
