# syntax=docker/dockerfile:1
FROM node:24-bookworm-slim AS build
WORKDIR /build
COPY . .
RUN --mount=type=secret,id=proxy_ca \
    if [ -f /run/secrets/proxy_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/proxy_ca; fi; \
    npm run setup && npm run build && \
    node ops/package-release.mjs /release --service-image && \
    npm --prefix /release/service ci --omit=dev --ignore-scripts --no-audit --no-fund && \
    npm --prefix /release/mcp ci --omit=dev --ignore-scripts --no-audit --no-fund
FROM node:24-bookworm-slim AS runtime
ARG REVISION=development
WORKDIR /app
COPY --from=build --chown=node:node /release/ ./
RUN mkdir /data /vault && chown node:node /data /vault && printf "%s\n" "$REVISION" > REVISION
USER node
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 DATA_DIR=/data VAULT_ROOT=/vault
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD ["node","-e","fetch('http://127.0.0.1:8080/api/v1/health').then(async r => process.exit(r.ok && (await r.json()).status === 'ready' ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node","service/index.mjs"]
