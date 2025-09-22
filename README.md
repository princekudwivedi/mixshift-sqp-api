## MixShift SQP API (Node.js)

Node.js service that implements the SQP cron flows and SQP-related APIs, ported from `dash-amazon-sp-api` PHP.

### Quick start

1. Create an env file and fill required values
```
cp .env.sample .env
```
2. Install and start
```
npm install
npm run dev   # or: npm start
```

Base URL (local): `http://localhost:3001/api/v1`

### Environment (minimum)

- MySQL master and tenant DB creds (see `src/config/sequelize.config.js` and `src/db/tenant.db.js`)
- AWS/S3 (optional for reports): `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`
- Amazon SP-API / LWA creds
- SMTP for notifications (optional): `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

You can validate SMTP with the script below.

### Auth, CORS, rate limits

- Optional token: Bearer token in `Authorization` header or `token` in body/query. Missing token does not block requests.
- CORS enabled for Angular and Postman usage.
- Rate limits:
  - `/sqp/*`: 100 requests / 15 minutes
  - `/cron/sqp/*`: 50 requests / 15 minutes

### API routes

All routes are consolidated in `src/routes/api.routes.js` and share the same middleware.

#### SQP APIs (non-cron)

- GET `/sqp/getAsinSkuList/:userId/:sellerID`
  - Returns ASIN list for a seller from `seller_ASIN_list` (no SKU join).
  - Path params: `userId` (number), `sellerID` (number)
  - Example:
    ```bash
    curl -X GET "http://localhost:3001/api/v1/sqp/getAsinSkuList/3/71"
    ```

- PUT `/sqp/updateAsinStatus/:userId/:sellerID/:asin`
  - Updates `seller_ASIN_list.IsActive` for a specific ASIN.
  - Path params: `userId`, `sellerID`, `asin`
  - Body: `status` must be 0 or 1. Accepts JSON or form-data.
  - Examples:
    ```bash
    # JSON
    curl -X PUT "http://localhost:3001/api/v1/sqp/updateAsinStatus/3/71/B09G766PQP" \
      -H "Content-Type: application/json" \
      -d '{"status":1}'

    # form-data
    curl -X PUT "http://localhost:3001/api/v1/sqp/updateAsinStatus/3/71/B09G766PQP" \
      -F status=0
    ```

#### Cron APIs (reports lifecycle)

- GET `/cron/sqp/request`
  - Request reports for one user or all users.
  - Query: `userId` (optional). If missing, processes all eligible users.
  - Example:
    ```bash
    curl -X GET "http://localhost:3001/api/v1/cron/sqp/request?userId=3"
    ```

- GET `/cron/sqp/status`
  - Check report statuses for pending entries; retries up to 3 times per entry.
  - Query: `userId` (optional)
  - Example:
    ```bash
    curl -X GET "http://localhost:3001/api/v1/cron/sqp/status?userId=3"
    ```

- GET `/cron/sqp/download`
  - Download completed reports and persist to DB / disk.
  - Query: `userId` (optional)
  - Example:
    ```bash
    curl -X GET "http://localhost:3001/api/v1/cron/sqp/download?userId=3"
    ```

- GET `/cron/sqp/all`
  - Runs request → status → download pipeline for one or all users.
  - Example:
    ```bash
    curl -X GET "http://localhost:3001/api/v1/cron/sqp/all?userId=3"
    ```

- GET `/cron/sqp/process-json`
  - Processes raw JSON files into DB tables.

- GET `/cron/sqp/copy-metrics`
  - Copies metrics into summary tables.

- GET `/cron/sqp/stats`
  - Returns processing stats and counts.

#### Cron APIs (ASIN sync)

- GET `/cron/asin/syncSellerAsins/:userId/:sellerID`
  - Pulls seller ASINs from PHP source and inserts into `seller_ASIN_list` (chunked bulk insert, duplicate-safe).
  - Example:
    ```bash
    curl -X GET "http://localhost:3001/api/v1/cron/asin/syncSellerAsins/3/71"
    ```

- GET `/cron/asin/cronSyncAllSellerAsins/:userId`
  - Syncs ASINs for all sellers under a specific user.

- GET `/cron/asin/cronSyncAllUsersSellerAsins`
  - Syncs ASINs for all agency users.

### Cron behavior and reliability

- Retries: Each entry is retried up to 3 times within the same run on failure.
- Logging: `sqp_cron_logs` and `sqp_cron_details` updated consistently; `ReportID` is preserved across retries.
- Notifications: After 3 failures for an entry, an email notification is sent (if SMTP configured).
- Shared retry helper: Centralized in `src/helpers/sqp.helpers.js`.

### Email test (SMTP diagnostics)

Use the helper script to verify SMTP configuration:
```bash
node src/scripts/sendTestEmail.js "to@example.com" "Subject test" "Body test"
```

### Code structure (high-level)

- `src/server.js` – Express server and app wiring
- `src/routes/api.routes.js` – Consolidated routes (APIs and crons)
- `src/controllers/sqp.api.controller.js` – Non-cron APIs
- `src/controllers/sqp.cron.api.controller.js` – Cron API endpoints (HTTP)
- `src/controllers/sqp.cron.controller.js` – Core cron logic (request/status/download)
- `src/helpers/sqp.helpers.js` – Retry helpers, notifications, validation
- `src/models/**` – Sequelize models (tenant-aware where needed)
- `src/cron/*` – File processing workers for JSON

### Cron jobs and recommended schedules

The service exposes HTTP cron endpoints and also includes local workers under `src/cron`. You can schedule either the HTTP endpoints (recommended when running behind a web server) or Node scripts.

Recommended schedules (24h time):

- Reports lifecycle
  - Request: every 6 hours
  - Status: every 15 minutes
  - Download: every 30 minutes
  - Process JSON: hourly (if using raw JSON processing)
  - Copy metrics: every 2 hours (or after downloads complete)

- ASIN sync
  - Sync all users: daily at 03:00
  - Sync one user / one seller: on demand

Linux crontab examples (HTTP via curl):
```bash
# Request every 6h
0 */6 * * * curl -fsS "http://localhost:3001/api/v1/cron/sqp/request" >> /var/log/sqp_request.log 2>&1

# Status every 15m
*/15 * * * * curl -fsS "http://localhost:3001/api/v1/cron/sqp/status" >> /var/log/sqp_status.log 2>&1

# Download every 30m
*/30 * * * * curl -fsS "http://localhost:3001/api/v1/cron/sqp/download" >> /var/log/sqp_download.log 2>&1

# Process JSON hourly
5 * * * * curl -fsS "http://localhost:3001/api/v1/cron/sqp/process-json" >> /var/log/sqp_process_json.log 2>&1

# Copy metrics every 2h
10 */2 * * * curl -fsS "http://localhost:3001/api/v1/cron/sqp/copy-metrics" >> /var/log/sqp_copy_metrics.log 2>&1

# ASIN sync all users daily @03:00
0 3 * * * curl -fsS "http://localhost:3001/api/v1/cron/asin/cronSyncAllUsersSellerAsins" >> /var/log/sqp_asin_sync_all.log 2>&1
```

Windows Task Scheduler examples:

- Program/script: `curl.exe`
- Arguments: `-fsS "http://localhost:3001/api/v1/cron/sqp/status"`
- Start in: leave empty or set to a safe working directory

Node worker (optional alternative to HTTP):
```bash
# Process any JSON files in the reports directory
node src/cron/process.json.files.cron.js

# Process previously saved JSON files
node src/cron/process.saved.json.files.cron.js
```

Notes:
- If your cron needs authentication, append `?token=<TOKEN>` or add `Authorization: Bearer <TOKEN>` with curl `-H`.
- You can scope any cron run to a specific `userId` using `?userId=<id>`.

### Notes

- Multi-tenancy: DB switching per user is handled internally via `loadDatabase(userId)`.
- Duplicates: ASIN sync uses chunked `bulkCreate(..., { ignoreDuplicates: true })` with per-record fallback.
- OpenAPI: See `openapi.yaml` for a schema outline (may be partial).

