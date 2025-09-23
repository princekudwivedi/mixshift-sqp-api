## MixShift SQP API – Developer Guide

This guide explains the codebase, core flows, key modules, and how to run, test, and operate the system.

### 1) Quick Start
- Install: `npm ci`
- Configure env: create `.env` (see Env section) or use `.env.production`
- Run dev: `npm run dev`
- Run prod: `NODE_ENV=production node src/server.js`

Base URL: server mounts all routes under `/api/v1`. Cron (reports) routes are under `/api/v1/cron/sqp`. ASIN sync cron routes are under `/api/v1/cron/asin`.

### 2) Architecture Overview
- Web server: `src/server.js`
  - Security: Helmet, CORS, compression, request ID, global error handler
  - IP allowlist for cron routes
- Routes: `src/routes/api.routes.js` (consolidated)
  - Controllers: `src/controllers/sqp.cron.api.controller.js`, `src/controllers/sqp.api.controller.js`
- Services:
  - JSON ingestion: `src/services/sqp.json.processing.service.js`
  - File-based processing & copy job: `src/services/sqp.file.processing.service.js`
- Models (Sequelize):
  - `src/models/sequelize/sqpDownloadUrls.model.js`
  - `src/models/sequelize/sqpMetrics3mo.model.js`
  - `src/models/sequelize/sqpMetrics.model.js`
  - Thin wrappers/helpers: `src/models/sqp.download.urls.model.js`, `src/models/sqp.metrics.model.js`
- DB & tenancy: `src/db/tenant.db.js`, `src/config/sequelize.config.js`
- Helpers: `src/helpers/sqp.helpers.js`
- Middleware: `src/middleware/*` (auth, rate limit, security headers, input sanitization)

### 3) Data Flow (High-Level)
1. Reports are downloaded and saved; entries live in `sqp_download_urls`.
2. JSON files are parsed and each record stored into `sqp_metrics_3mo`.
3. A bulk copy job moves data from `sqp_metrics_3mo` to `sqp_metrics`.
4. After successful copy, `sqp_download_urls.FullyImported` is updated to `2`.

### 4) Key Endpoints (Cron API + Health)
Mounted at: `/api/v1`
- Reports lifecycle (`/cron/sqp`):
  - `GET /cron/sqp/request` – Request new reports (supports `userId`)
  - `GET /cron/sqp/status` – Check report statuses (retries up to 3x per entry)
  - `GET /cron/sqp/download` – Download completed reports
  - `GET /cron/sqp/process-json` – JSON processing
  - `GET /cron/sqp/stats` – Processing stats
  - `GET /cron/sqp/all` – Run request → status → download pipeline
  - `GET /cron/sqp/copy-metrics` – Copy from 3mo to main metrics (bulk)
- ASIN sync (`/cron/asin`):
  - `GET /cron/asin/syncSellerAsins/:userId/:sellerID`
  - `GET /cron/asin/cronSyncAllSellerAsins/:userId`
  - `GET /cron/asin/cronSyncAllUsersSellerAsins`
- SQP APIs (non-cron) (`/sqp`):
  - `GET /sqp/getAsinSkuList/:userId/:sellerID`
  - `PUT /sqp/updateAsinStatus/:userId/:sellerID/:asin` (body `status` 0 or 1; JSON or form-data)

Health/Readiness:
- `GET /healthz` – Liveness (always 200 when server up)
- `GET /readyz` – Readiness (checks DB connectivity, 200/503)

Query params commonly supported: `userId`; for copy job: `batchSize`, `dryRun`, `force`.

Examples (Dev, token optional except where noted):
```bash
curl -H "Authorization: Bearer <TOKEN>" \
  "http://localhost:3001/api/v1/cron/sqp/copy-metrics?userId=3&batchSize=500&dryRun=true"

curl -H "Authorization: Bearer <TOKEN>" \
  "http://localhost:3001/api/v1/cron/sqp/copy-metrics?userId=3&batchSize=500&force=true"

# Request/status/download/all (token optional with default setup)
curl "http://localhost:3001/api/v1/cron/sqp/request?userId=3"
curl "http://localhost:3001/api/v1/cron/sqp/status?userId=3"
curl "http://localhost:3001/api/v1/cron/sqp/download?userId=3"
curl "http://localhost:3001/api/v1/cron/sqp/all?userId=3"

# ASIN sync
curl "http://localhost:3001/api/v1/cron/asin/syncSellerAsins/3/71"
curl "http://localhost:3001/api/v1/cron/asin/cronSyncAllSellerAsins/3"
curl "http://localhost:3001/api/v1/cron/asin/cronSyncAllUsersSellerAsins"
```

### 5) Bulk Copy Logic (Where/How)
- Service: `src/services/sqp.file.processing.service.js`
  - `copyDataWithBulkInsert({ batchSize, dryRun, force, insertChunkSize })`
    - Discovers report IDs (via `sqp.metrics.model.getReportIdsWithDataIn3mo()`)
    - Dry run: counts distinct logical rows (ASIN+SearchQuery) per `ReportID`
    - Copy: loads 3mo records per `ReportID`, dedupes by ASIN+SearchQuery+ReportDate
    - Chunked `bulkCreate` with transaction per report
      - `ignoreDuplicates: !force`
      - `updateOnDuplicate` when `force=true`
    - Updates `sqp_download_urls` to mark copied (`FullyImported=2`)

### 6) JSON Ingestion (3mo Table)
- Service: `src/services/sqp.json.processing.service.js`
- Writes to `sqp_metrics_3mo` via `src/models/sqp.metrics.model.js` and `sequelize/sqpMetrics3mo.model.js`
- Duplicate prevention per report: the service clears old rows for `ReportID` before storing new batch

### 7) Environment & Security
- Env: `src/config/env.config.js`
  - Safe parsers, strict production checks (non-default secrets, explicit CORS)
- Required vars (subset): `DB_HOST`, `DB_USER`, `DB_NAME`, SMTP vars if notifications, SP-API/LWA creds
- Security:
  - Auth middleware: `src/middleware/auth.middleware.js` (optional token)
  - Rate limit: `AuthMiddleware.rateLimit()`
  - Headers & CSP: Helmet + custom headers
  - RBAC (optional): `src/middleware/authz.middleware.js`

Tokens & roles:
- Static token: set `API_ACCESS_TOKEN` and `API_TOKEN_ROLES=operator,admin` on the server; pass token via `Authorization: Bearer` or `?token=`
- JWT: include `roles` claim and sign with `JWT_SECRET`

### 8) Database
- Schemas (SQL samples): `src/database/*.sql`
- Recommended indexes:
  - On both metrics tables: composite `(ReportID, ASIN, SearchQuery, ReportDate)`
  - Consider unique index on `sqp_metrics` composite key to avoid duplicates in main table

### 9) Operations & Observability
- Logs: `src/utils/logger.utils.js` (pino)
- Health (add if needed): implement `/health` and `/readiness`
- Metrics (optional): add Prometheus exporter (copy timings, counts, errors)

OpenAPI docs:
- Spec file: `openapi.yaml` (partial)
- Import into Postman or serve with Swagger UI if desired.

### 10) Common Commands
```bash
# Dev server
npm run dev

# Prod
NODE_ENV=production node src/server.js

# Copy metrics dry run
curl -H "Authorization: Bearer <TOKEN>" \
  "http://localhost:3001/api/v1/cron/sqp/copy-metrics?userId=3&dryRun=true&batchSize=500"

# Copy metrics (force overwrite)
curl -H "Authorization: Bearer <TOKEN>" \
  "http://localhost:3001/api/v1/cron/sqp/copy-metrics?userId=3&force=true&batchSize=1000"

# OpenAPI quick preview (VSCode/clients) or host Swagger UI if added
```

### 11) Troubleshooting
- Dry-run counts doubled → ensure logical distinct keys match your schema (ASIN+SearchQuery)
- Duplicate errors on copy → add unique index; use `force=true` or adjust dedupe key
- 403 on cron endpoints → add your IP to `CRON_ALLOWED_IPS`
- 401 → provide `Authorization: Bearer <TOKEN>` or valid token via query

### 12) Roadmap (to reach 9.5–10.0)
- RBAC/permissions (wire `requireRole` on sensitive routes)
- OpenAPI docs (added), health/readiness endpoints (added)
- CI with tests/coverage and SAST
- Metrics & dashboards for copy job performance

RBAC wiring example (in `src/routes/cron.routes.js`):
```js
const { requireRole } = require('../middleware/authz.middleware');
// Protect copy endpoint for operators and admins
router.get('/copy-metrics', requireRole(['operator','admin']), (req, res) => sqpCronApiController.copyMetricsData(req, res));
```

### 13) Key Files Map
- Server: `src/server.js`
- Routes: `src/routes/api.routes.js`
- Controller: `src/controllers/sqp.cron.api.controller.js`
- Copy Service: `src/services/sqp.file.processing.service.js`
- JSON Service: `src/services/sqp.json.processing.service.js`
- Models: `src/models/*`, `src/models/sequelize/*`
- Middleware: `src/middleware/*`
- Config: `src/config/*`


