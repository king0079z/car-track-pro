# All-in-one web tier — builds the React frontend, then serves it as static files
# AND reverse-proxies /api + /ws to the FastAPI backend via Caddy (auto-HTTPS).
# Multi-arch (linux/amd64 + linux/arm64) so it runs on Oracle Cloud's free
# Ampere A1 (ARM) as well as x86 VMs.
#
# Build context must be the REPO ROOT (so it can read ./frontend), e.g.:
#   docker build -f deploy/cloud/frontend.Dockerfile -t cartrack-web .

FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
# Same-origin deployment: the API and WebSocket are served from the SAME host
# through Caddy, so the app must use relative URLs. Gateway mode makes
# API_BASE_URL = "" (relative /api) and the WS connect to wss://<host>/ws.
RUN printf 'VITE_GATEWAY_MODE=true\n' > .env.production \
    && npm run build

FROM caddy:2-alpine
# Static SPA bundle; the Caddyfile is bind-mounted by docker-compose so it can be
# tweaked without rebuilding this image.
COPY --from=build /app/dist /srv
EXPOSE 80 443
