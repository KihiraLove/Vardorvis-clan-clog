FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json
COPY apps/bot/package.json ./apps/bot/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/domain/package.json ./packages/domain/package.json
COPY packages/database/package.json ./packages/database/package.json
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM build AS production-dependencies
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim AS service-base
WORKDIR /app
ENV NODE_ENV=production
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/bot/package.json ./apps/bot/package.json
COPY --from=build --chown=node:node /app/apps/bot/dist ./apps/bot/dist
COPY --from=build --chown=node:node /app/packages/domain/package.json ./packages/domain/package.json
COPY --from=build --chown=node:node /app/packages/domain/dist ./packages/domain/dist
COPY --from=build --chown=node:node /app/packages/database/package.json ./packages/database/package.json
COPY --from=build --chown=node:node /app/packages/database/dist ./packages/database/dist
COPY --from=build --chown=node:node /app/packages/database/migrations ./packages/database/migrations
LABEL org.opencontainers.image.source="https://github.com/KihiraLove/Vardorvis-clan-clog"
USER node

FROM service-base AS api
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3000/readyz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/dist/server.js"]

FROM service-base AS bot
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:3001/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/bot/dist/index.js"]

FROM nginxinc/nginx-unprivileged:stable-alpine AS web
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
LABEL org.opencontainers.image.source="https://github.com/KihiraLove/Vardorvis-clan-clog"
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
