# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm run setup && npm run build && \
    node ops/package-release.mjs /release && \
    npm --prefix /release/service ci --omit=dev --ignore-scripts --no-audit --no-fund && \
    npm --prefix /release/mcp ci --omit=dev --ignore-scripts --no-audit --no-fund
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build --chown=node:node /release/ ./
RUN mkdir /data /vault && chown node:node /data /vault
USER node
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data VAULT_ROOT=/vault
EXPOSE 8080
CMD ["node","service/index.mjs"]
