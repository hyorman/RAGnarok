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
    npm run build --workspace=@ragnarok/mcp-server

# Install only the two runtime workspaces. The repository root deliberately
# carries cross-platform VS Code packaging dependencies that do not belong in
# the MCP image.
FROM node:22-slim AS production-deps

WORKDIR /app
ARG TARGETARCH

COPY package.json package-lock.json .npmrc ./
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/vscode/package.json packages/vscode/

RUN npm ci --omit=dev --omit=peer --ignore-scripts --libc=glibc \
      --workspace=@ragnarok/core \
      --workspace=@ragnarok/mcp-server \
      --include-workspace-root=false && \
    npm cache clean --force && \
    case "${TARGETARCH}" in \
      amd64) onnx_arch=x64 ;; \
      arm64) onnx_arch=arm64 ;; \
      *) echo "Unsupported MCP image architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac && \
    onnx_bin=node_modules/@huggingface/transformers/node_modules/onnxruntime-node/bin/napi-v3 && \
    rm -rf "${onnx_bin}/darwin" "${onnx_bin}/win32" && \
    find "${onnx_bin}/linux" -mindepth 1 -maxdepth 1 -type d ! -name "${onnx_arch}" -exec rm -rf {} + && \
    rm -rf \
      node_modules/@huggingface/transformers/node_modules/onnxruntime-web \
      node_modules/@huggingface/transformers/src \
      node_modules/@huggingface/transformers/types \
      node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.mjs \
      node_modules/@huggingface/transformers/dist/ort-wasm-simd-threaded.jsep.wasm \
      node_modules/@huggingface/transformers/dist/transformers.js \
      node_modules/@huggingface/transformers/dist/transformers.min.js \
      node_modules/@huggingface/transformers/dist/transformers.web.js \
      node_modules/@huggingface/transformers/dist/transformers.web.min.js \
      node_modules/@lancedb/lancedb/node_modules/@lancedb/*-musl \
      node_modules/@lancedb/*-musl && \
    find node_modules packages/core/node_modules packages/mcp-server/node_modules \
      -type f \( -name '*.map' -o -name '*.d.ts' \) -delete

# ─── Runtime stage ─────────────────────────────────────
FROM node:22-slim AS runtime

WORKDIR /app

# Copy built packages and their node_modules
COPY --chown=node:node --from=build /app/packages/core/dist/ packages/core/dist/
COPY --chown=node:node --from=build /app/packages/core/package.json packages/core/
COPY --chown=node:node --from=build /app/packages/mcp-server/dist/ packages/mcp-server/dist/
COPY --chown=node:node --from=build /app/packages/mcp-server/package.json packages/mcp-server/

# Copy node_modules (all hoisted to root via install-strategy=shallow)
COPY --chown=node:node --from=production-deps /app/node_modules/ node_modules/
# Copy workspace-level modules that npm keeps nested because of lockfile
# placement or version conflicts.
COPY --chown=node:node --from=production-deps /app/packages/core/node_modules/ packages/core/node_modules/
COPY --chown=node:node --from=production-deps /app/packages/mcp-server/node_modules/ packages/mcp-server/node_modules/

# Copy bundled models (if present) — shipped inside the core package
COPY --chown=node:node packages/core/assets/models/ packages/core/assets/models/
COPY --chown=node:node NOTICE THIRD_PARTY_MODELS.md bom.cdx.json bom.spdx.json /app/
COPY --chown=node:node scripts/container-healthcheck.mjs /app/scripts/container-healthcheck.mjs

ENV NODE_ENV=production
ENV RAGNAROK_STORAGE_DIR=/data/ragnarok
ENV RAGNAROK_HTTP_HOST=0.0.0.0
ENV RAGNAROK_PORT=4000

RUN mkdir -p /data/ragnarok && chown node:node /data/ragnarok
USER node

EXPOSE 4000
STOPSIGNAL SIGTERM

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "/app/scripts/container-healthcheck.mjs"]

CMD ["node", "packages/mcp-server/dist/index.js", "--http"]
