# ═══════════════════════════════════════════════════════════
# EMS Claims Portal — Frontend Production Dockerfile
# Multi-stage build: deps → build → Nginx serve
# ═══════════════════════════════════════════════════════════

# ── Stage 1: Build ──
FROM node:20-alpine AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci --no-audit

COPY . .

# Build production bundle
ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build


# ── Stage 2: Serve with Nginx ──
FROM nginx:1.25-alpine AS production

LABEL maintainer="EMS Claims Portal <admin@emsclaims.co.za>"
LABEL description="EMS Claims Portal — Frontend"

# Copy built assets
COPY --from=build /app/dist /usr/share/nginx/html

# Copy custom Nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Security headers
RUN rm /etc/nginx/conf.d/default.conf 2>/dev/null; exit 0

COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -q --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
