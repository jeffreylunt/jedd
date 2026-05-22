# --- Build stage: compile TypeScript -> dist/ ---
FROM node:22-alpine AS build
WORKDIR /app

# Install all deps (incl. devDependencies for the TypeScript compiler).
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune to production dependencies only for the runtime stage.
RUN npm prune --omit=dev

# --- Runtime stage: slim image with compiled JS + prod deps only ---
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run as the built-in non-root "node" user.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# Persisted state (state.json) lives here — mount a volume at /app/data.
RUN mkdir -p /app/data && chown node:node /app/data

USER node

# The BlueBubbles webhook receiver listens here (override with BLUEBUBBLES_WEBHOOK_PORT).
EXPOSE 18790

# Healthcheck hits the webhook server's /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.BLUEBUBBLES_WEBHOOK_PORT||18790)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
