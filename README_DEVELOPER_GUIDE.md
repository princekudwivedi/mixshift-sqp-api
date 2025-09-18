## MixShift SQP API – Developer Guide

This guide explains the codebase, core flows, key modules, and how to run, test, and operate the system.

### 1) Quick Start
- Install: `npm ci`
- Configure env: create `.env` (see Env section) or use `.env.production`
- Run dev: `npm run dev`
- Run prod: `NODE_ENV=production node src/server.js`

Base URL: server mounts cron routes at `/api/v1/cron/sqp`. Health endpoints are at `/healthz` and `/readyz`.

### 2) Architecture Overview
- Web server: `src/server.js`
  - Security: Helmet, CORS, compression, request ID, global error handler
  - IP allowlist for cron routes
- Routes: `src/routes/cron.routes.js`
  - Controller: `src/controllers/sqp.cron.api.controller.js`
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
Mounted at: `/api/v1/cron/sqp`
- `GET /request` – Request new reports
- `GET /status` – Check report statuses
- `GET /download` – Download completed reports
- `GET /process-json` – Legacy JSON processing
- `GET /stats` – Processing stats
- `GET /copy-metrics` – Copy from 3mo to main metrics (bulk)

Health/Readiness:
- `GET /healthz` – Liveness (always 200 when server up)
- `GET /readyz` – Readiness (checks DB connectivity, 200/503)

Query params commonly supported: `userId`, and for copy job: `batchSize`, `dryRun`, `force`.

Examples:
```bash
curl -H "Authorization: Bearer <TOKEN>" \
  "http://localhost:3001/api/v1/cron/sqp/copy-metrics?userId=3&batchSize=500&dryRun=true"

curl -H "Authorization: Bearer <TOKEN>" \
  "http://localhost:3001/api/v1/cron/sqp/copy-metrics?userId=3&batchSize=500&force=true"

# Health checks
curl "http://localhost:3001/healthz"
curl "http://localhost:3001/readyz"
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
- Required vars (subset): `DB_HOST`, `DB_USER`, `DB_NAME`, `JWT_SECRET`, `SESSION_SECRET`
- Security:
  - Auth middleware: `src/middleware/auth.middleware.js` (JWT + token)
  - IP allowlist: `src/middleware/ip.allowlist.middleware.js`
  - Rate limit: `AuthMiddleware.rateLimit()`
  - Headers & CSP: Helmet + custom headers
  - RBAC (optional): `src/middleware/authz.middleware.js` (`requireRole([...])`)

Add roles to JWT as `roles` claim (e.g., `{"roles":["admin","operator"]}`) or attach `req.user.roles` in your auth flow.

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
- Spec file: `openapi.yaml`
- You can serve with Swagger UI in dev or import into Postman.

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
- Routes: `src/routes/cron.routes.js`
- Controller: `src/controllers/sqp.cron.api.controller.js`
- Copy Service: `src/services/sqp.file.processing.service.js`
- JSON Service: `src/services/sqp.json.processing.service.js`
- Models: `src/models/*`, `src/models/sequelize/*`
- Middleware: `src/middleware/*`
- Config: `src/config/*`


