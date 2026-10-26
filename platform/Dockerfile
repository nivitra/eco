FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS build
WORKDIR /build/platform
COPY platform/package*.json ./
RUN npm ci --ignore-scripts && node node_modules/esbuild/install.js
COPY platform/tsconfig.json ./
COPY platform/src ./src
COPY platform/scripts ./scripts
COPY platform/migrations ./migrations
COPY platform/data ./data
COPY platform/tests ./tests
COPY platform/ops ./ops
WORKDIR /build/console
COPY console/package*.json ./
RUN npm ci --ignore-scripts && node node_modules/esbuild/install.js
COPY console/tsconfig.json console/vite.config.ts console/index.html ./
COPY console/src ./src
COPY console/public ./public
COPY console/tests ./tests
RUN npm test && npm run build
WORKDIR /build/platform
RUN npm run build && npm prune --omit=dev --ignore-scripts
RUN node --input-type=module -e "import sharp from 'sharp'; await sharp({create:{width:1,height:1,channels:3,background:'black'}}).webp().toBuffer()"
FROM node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ENV NODE_ENV=production CONSOLE_ROOT=/app/console MEDIA_ROOT=/var/lib/kulture/media
WORKDIR /app
COPY --from=build --chown=node:node /build/platform/node_modules ./node_modules
COPY --from=build --chown=node:node /build/platform/package*.json ./
COPY --from=build --chown=node:node /build/platform/dist ./dist
COPY --from=build --chown=node:node /build/platform/migrations ./dist/migrations
COPY --from=build --chown=node:node /build/platform/data ./dist/data
COPY --from=build --chown=node:node /build/platform/ops ./ops
COPY --from=build --chown=node:node /build/console/dist ./console
RUN mkdir -p /var/lib/kulture/media && chown node:node /var/lib/kulture/media
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD ["node","dist/scripts/api-health.js"]
CMD ["node","dist/src/server.js"]
