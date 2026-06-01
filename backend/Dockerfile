# ═══════════════════════════════════════════════════════════
# EMS Claims Portal — Backend Production Dockerfile
# Multi-stage build: deps → test → production slim image
# ═══════════════════════════════════════════════════════════

# ── Stage 1: Dependencies ──
FROM python:3.12-alpine AS deps

WORKDIR /app

RUN apk add --no-cache \
    gcc \
    musl-dev \
    postgresql-dev \
    jpeg-dev \
    zlib-dev \
    libffi-dev \
    curl \
    build-base

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt


# ── Stage 2: Production ──
FROM python:3.12-alpine AS production

LABEL maintainer="EMS Claims Portal <admin@emsclaims.co.za>"
LABEL description="EMS Claims Portal — FastAPI Backend"

# Security: run as non-root
RUN addgroup -S ems && adduser -S -G ems -h /app -s /bin/false ems

WORKDIR /app

# Install runtime deps only (no gcc)
RUN apk add --no-cache \
    libpq \
    jpeg \
    zlib \
    curl

# Copy installed packages from deps stage
COPY --from=deps /install /usr/local

# Copy application code
COPY . .

# Create directories
RUN mkdir -p /app/uploads /app/logs && chown -R ems:ems /app

# Switch to non-root user
USER ems

EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=15s --retries=3 \
    CMD curl -f http://localhost:8000/health || exit 1

# Production: no --reload, use multiple workers
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8000", \
     "--workers", "4", \
     "--access-log", \
     "--proxy-headers", \
     "--forwarded-allow-ips", "*"]
