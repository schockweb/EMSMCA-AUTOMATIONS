# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

EMS Medical Claims Ingestion Portal — a full-stack web application automating emergency medical services insurance claim processing. The pipeline goes: PDF upload → AI OCR extraction → adjudication rules engine → EDI submission → ERA tracking.

## Commands

### Backend (Python/FastAPI)
```bash
cd backend
pip install -r requirements.txt
uvicorn app.main:app --reload          # Dev server on :8000
celery -A app.tasks.celery_app worker --loglevel=info  # Async task worker
alembic upgrade head                   # Apply migrations
alembic revision --autogenerate -m "description"       # Generate migration
pytest                                 # Run tests
```

### Frontend (React/TypeScript)
```bash
cd frontend
npm install
npm run dev    # Vite dev server on :5173
npm run build  # tsc -b && vite build
npm run lint   # ESLint
```

### Full Stack (Docker)
```bash
docker-compose up          # All 5 services
docker-compose up backend  # Single service
```

## Architecture

### Data Flow
```
Frontend (React :5173) → FastAPI (:8000) → PostgreSQL
                                         → RabbitMQ → Celery Workers
                                         → LlamaParse / Mistral (OCR)
                                         → Claid.ai (image preprocessing)
                                         → Medical Scheme APIs (auth/EDI)
```

### Document Processing Pipeline
Document states: `PENDING → PREPROCESSING → EXTRACTING → COMPLETED`

1. `POST /api/documents/upload` — stores file, triggers Celery preprocessing task
2. Celery calls Claid.ai for image enhancement, then LlamaParse for OCR
3. Mistral AI serves as OCR fallback
4. Extracted data auto-creates `Case` and `Claim` entities
5. Adjudication engine validates against scheme rules and GEMS tariffs
6. Scheme authorization requested; on approval, EDI 837 generated and submitted

### Backend Structure (`backend/app/`)
- `main.py` — FastAPI app, middleware registration, lifespan (startup: seeds data, purges 90-day crash logs)
- `config.py` — Pydantic Settings (reads env vars)
- `database.py` — SQLAlchemy async session factory (asyncpg driver)
- `api/` — 28 FastAPI routers; each file maps to one domain
- `models/` — 28 SQLAlchemy ORM models
- `services/` — Core business logic. Largest/most complex files:
  - `tariff_engine.py` (53KB) — GEMS tariff rate lookups and calculations
  - `ocr_extraction.py` (53KB) — LlamaParse + Mistral orchestration
  - `adjudication_engine.py` (41KB) — Medical claim validation rule engine
  - `mileage_engine.py` (28KB) — Transport cost calculations
  - `rule_engine.py` (24KB) — Dynamic scheme rule evaluation
  - `edi_generator.py` (19KB) — EDI 837 format generation
  - `claims_pipeline.py` (14KB) — End-to-end orchestration
- `tasks/` — Celery tasks for async preprocessing and extraction
- `middleware/` — Applied in order: ErrorLogging → CORS → RateLimit (10 auth/min, 300 API/min) → XSSProtection → CrashHandler
- `schemas/` — Pydantic request/response models
- `utils/` — JWT auth, bcrypt password hashing, file storage helpers

### Frontend Structure (`frontend/src/`)
- `App.tsx` — Root router and layout
- `pages/` — 16+ page components (Dashboard, Upload, AdminQueue, Adjudication, Cases, DocumentReview, RuleBuilder, ERATracking, crew/*)
- `contexts/AuthContext.tsx` — Global auth state (JWT storage, role/permission checks)
- `api/` — Centralized Axios client; `/api` proxied to `http://backend:8000` via Vite config

### Key Domain Concepts
- **Case** — An EMS event/incident; wraps one or more Claims
- **Claim** — A medical claim with adjudication status and ClaimLines
- **ClaimLine** — Individual billable item (procedure code, tariff rate, quantity)
- **Document** — Uploaded PRF (Patient Report Form) with OCR lifecycle state
- **DigitalPRF** — Structured patient report data (alternative to scanned PDF)
- **SchemeAuthRequest** — Pre-authorization request to medical scheme
- **EDISubmission** — EDI 837 transaction record
- **ERAEvent** — Electronic Remittance Advice reconciliation record
- **RFI** — Request For Information flag for missing/unclear data

### Authentication & Security
- JWT (HS256) access tokens + 7-day refresh tokens
- Roles: `SUPER_ADMIN`, `ADMIN`, `USER`; fine-grained permissions (e.g., `rule_builder`, `dashboard`)
- Sensitive fields (patient ID numbers) encrypted at rest for POPIA compliance
- Default seed admin: `admin@emsclaims.co.za` / `Admin@2024!` (dev only)

## Environment Variables

Copy `.env.example` to `.env`. Required variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (asyncpg driver) |
| `CELERY_BROKER_URL` | RabbitMQ URL |
| `SECRET_KEY` | JWT signing key |
| `ENCRYPTION_KEY` | POPIA field encryption key |
| `LLAMA_CLOUD_API_KEY` | LlamaParse OCR (primary) |
| `FRONTEND_URL` | CORS whitelist |
| `UPLOAD_DIR` | File storage path |

Optional: `MISTRAL_API_KEY` (OCR fallback), `CLAID_API_KEY` (image preprocessing).

## Docker Services

`docker-compose.yml` defines:
1. `postgres` — PostgreSQL 16 (`:5432`)
2. `rabbitmq` — RabbitMQ 3.13 (AMQP `:5672`, management UI `:15672`)
3. `backend` — FastAPI (`:8000`)
4. `celery_worker` — Async task processor
5. `frontend` — Vite dev server (`:5173`) with filesystem polling for Windows Docker HMR

## API Documentation

Available at `http://localhost:8000/docs` (Swagger) or `/redoc` when running in development mode.
