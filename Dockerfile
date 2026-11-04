# syntax=docker/dockerfile:1

# ---- Étape 1 : compilation TypeScript ----
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Étape 2 : dépendances de production seulement ----
FROM node:26-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Étape 3 : image d'exécution minimale, sans droits root ----
FROM node:26-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
USER node
EXPOSE 4001
# Sonde Docker : /health répond 503 si MongoDB est injoignable.
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-4001}/health || exit 1
# instrumentation.js est chargé en premier (traces OpenTelemetry) ; il ne fait rien sans OTEL_EXPORTER_OTLP_ENDPOINT.
CMD ["node", "--import", "./dist/instrumentation.js", "dist/server.js"]
