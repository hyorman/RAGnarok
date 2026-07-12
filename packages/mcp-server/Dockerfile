# ─── Build stage ───────────────────────────────────────
FROM node:22-slim AS build

WORKDIR /app

# Copy workspace root files
COPY package.json package-lock.json .npmrc tsconfig.base.json ./

# Copy only the packages needed (core + mcp-server + vscode for lockfile validation)
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/vscode/package.json packages/vscode/

# Install all dependencies so mcp-server's full dep tree is available
RUN npm ci --ignore-scripts

# Copy source code
COPY packages/core/ packages/core/
COPY packages/mcp-server/ packages/mcp-server/

# Build both packages
RUN npm run build --workspace=@ragnarok/core && \
    npm run build --workspace=@ragnarok/mcp-server && \
    npm prune --omit=dev --ignore-scripts

# ─── Runtime stage ─────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# Copy workspace manifest so node resolves workspace packages
COPY package.json .npmrc ./

# Copy built packages and their node_modules
COPY --from=build /app/packages/core/dist/ packages/core/dist/
COPY --from=build /app/packages/core/package.json packages/core/
COPY --from=build /app/packages/mcp-server/dist/ packages/mcp-server/dist/
COPY --from=build /app/packages/mcp-server/package.json packages/mcp-server/

# Copy node_modules (all hoisted to root via install-strategy=shallow)
COPY --from=build /app/node_modules/ node_modules/
# Copy mcp-server's workspace-level node_modules (version-conflicted deps not hoisted to root)
COPY --from=build /app/packages/mcp-server/node_modules/ packages/mcp-server/node_modules/

# Copy bundled models (if present) — shipped inside the core package
COPY packages/core/assets/models/ packages/core/assets/models/

ENV NODE_ENV=production
ENV RAGNAROK_STORAGE_DIR=/data/ragnarok
ENV RAGNAROK_HTTP_HOST=0.0.0.0
ENV RAGNAROK_PORT=4000

RUN mkdir -p /data/ragnarok && chown -R node:node /data/ragnarok /app
USER node

EXPOSE 4000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:' + (process.env.RAGNAROK_PORT || 4000) + '/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "packages/mcp-server/dist/index.js", "--http"]
