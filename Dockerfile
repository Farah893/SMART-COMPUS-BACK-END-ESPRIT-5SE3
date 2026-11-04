# syntax=docker/dockerfile:1

# L'image de base est épinglée par DIGEST (et non par l'étiquette mobile `22-alpine`) : le build est reproductible et une image
# de base modifiée en amont ne change rien sans que ce fichier ne change. À rafraîchir régulièrement (voir docs/SAST-ET-IMAGE-DOCKER.md).
# Le scan Trivy de la CI échoue si l'image épinglée contient une faille corrigeable : c'est le signal pour mettre à jour le digest.
# ---- Étape 1 : compilation TypeScript ----
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts : aucun script d'installation de dépendance ne s'exécute pendant la construction (chaîne d'approvisionnement).
RUN npm ci --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---- Étape 2 : dépendances de production seulement ----
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS deps
ENV SCARF_ANALYTICS=false
WORKDIR /app
COPY package.json package-lock.json ./
# Dépendances de production sans scripts d'installation : évite notamment la télémétrie de @scarf/scarf (via swagger-ui-dist)
# et le postinstall de protobufjs, inutiles à l'exécution (démarrage vérifié sans eux).
RUN npm ci --omit=dev --ignore-scripts

# ---- Étape 3 : image d'exécution minimale, sans droits root ----
FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime
ENV NODE_ENV=production SCARF_ANALYTICS=false
# Le conteneur de production n'a besoin QUE de `node` : on retire npm, npx, corepack et yarn (livrés avec l'image de base).
#  - ils embarquent leurs propres dépendances (pacote, sigstore, picomatch, brace-expansion, ip-address…) que Trivy a signalées
#    comme vulnérables alors que le service ne s'en sert jamais ;
#  - un attaquant qui obtiendrait un shell dans le conteneur ne pourrait plus installer d'outils avec `npm install`.
# Doit s'exécuter AVANT `USER node` (il faut les droits root pour supprimer).
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
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
