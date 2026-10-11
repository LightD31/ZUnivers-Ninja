# syntax=docker/dockerfile:1

# Image de base surchargeable (miroir, registre interne…) :
#   docker build --build-arg NODE_IMAGE=mirror.gcr.io/library/node:22-alpine .
ARG NODE_IMAGE=node:22-alpine

# --- Build : dépendances, tests, interface web et serveur -------------------
# Toujours sur la plateforme de l'hôte : le résultat (JS + fichiers statiques) ne
# dépend pas de l'architecture, et les tests sous émulation QEMU (arm64) sont trop lents.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm test && pnpm build

# --- Exécution : le serveur JS (+ thread du planificateur) et l'interface ----
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="ZUnivers Ninja" \
      org.opencontainers.image.description="Conseiller ZUnivers : interface web, API et notifications Discord" \
      org.opencontainers.image.source="https://github.com/LightD31/ZUnivers-Ninja"
ENV NODE_ENV=production \
    TZ=Europe/Paris \
    PORT=8080 \
    STATE_FILE=/data/state.json \
    WEB_DIR=/app/web
WORKDIR /app
COPY --from=build /src/apps/worker/dist/ ./
COPY --from=build /src/apps/web/dist ./web
RUN mkdir -p /data && chown node:node /data
# Version affichée par /health, fournie par le workflow de release (tag vX.Y.Z → X.Y.Z).
# Déclarée en dernier : changer de version ne reconstruit pas les couches précédentes.
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "index.js"]
