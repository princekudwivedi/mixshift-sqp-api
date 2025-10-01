# MixShift SQP API (Node.js)

Node.js service for Amazon SP-API Search Query Performance (SQP) report automation with comprehensive retry logic, error handling, and automatic import processing.

## 🚀 Quick Start

### 1. Environment Setup
```bash
# Copy environment template
cp .env.sample .env
# Edit .env and configure required values
```

### 2. Install and Run
```bash
npm install
npm run dev   # Development mode with auto-reload
npm start     # Production mode
```

**Base URL:** `http://localhost:3001/api/v1`

---

## ✨ Key Features

- ✅ **Automated SQP Report Processing** - Request → Status Check → Download → Import
- ✅ **Multi-Tenant Support** - Dynamic database switching per user
- ✅ **Intelligent Retry Logic** - Exponential backoff with configurable attempts
- ✅ **Immediate Import** - Downloaded data imports to database automatically
- ✅ **Denver Timezone Support** - All date calculations use America/Denver timezone
- ✅ **Comprehensive Logging** - Detailed audit trail in database tables
- ✅ **Email Notifications** - Automatic alerts on failures (SMTP required)
- ✅ **Global Error Handling** - Prevents server crashes on unhandled errors
- ✅ **ASIN Management** - Sync and manage seller ASINs

---

## 🔧 Environment Configuration

### Required Variables

#### Database
```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=dev_dash_applications
```

#### Amazon SP-API Credentials
```env
LWA_CLIENT_ID=amzn1.application-oa2-client.xxxxx
LWA_CLIENT_SECRET=xxxxx
LWA_REFRESH_TOKEN=Atzr|xxxxx
MERCHANT_REGION=America
MARKETPLACE_ID=ATVPDKIKX0DER
```

#### Timing & Retry Configuration
```env
# Delays (in seconds)
INITIAL_DELAY_SECONDS=30
RETRY_BASE_DELAY_SECONDS=30
RETRY_MAX_DELAY_SECONDS=120
MAX_RETRY_ATTEMPTS=3

# Report types to process (comma-separated)
TYPE_ARRAY=WEEK,MONTH,QUARTER
```

#### Email Notifications (Optional)
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-app-password
SMTP_FROM=noreply@yourdomain.com
NOTIFY_TO=admin@yourdomain.com
NOTIFY_CC=manager@yourdomain.com
```

#### Server & Security
```env
NODE_ENV=development
PORT=3001
AUTH_TOKEN=your-secret-token
ALLOWED_ORIGINS=http://localhost:4200
```

---

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

## 📡 API Endpoints

### Non-Cron APIs

#### Get ASIN List
```bash
GET /api/v1/sqp/getAsinSkuList/:userId/:sellerID
```

**Example:**
```bash
curl "http://localhost:3001/api/v1/sqp/getAsinSkuList/8/600"
```

#### Update ASIN Status
```bash
PUT /api/v1/sqp/updateAsinStatus/:userId/:sellerID/:asin
```

**Example:**
```bash
curl -X PUT "http://localhost:3001/api/v1/sqp/updateAsinStatus/8/600/B09G766PQP" \
  -H "Content-Type: application/json" \
  -d '{"status": 1}'
```

---

### Cron APIs

#### All Operations (Recommended)
```bash
GET /api/v1/cron/sqp/all
```

Runs complete workflow: Request → Status Check → Download → Import

**Query Parameters:**
- `userId` (optional) - Process specific user only
- `sellerId` (optional) - Process specific seller only

**Example:**
```bash
# Process all users
curl "http://localhost:3001/api/v1/cron/sqp/all"

# Process specific user
curl "http://localhost:3001/api/v1/cron/sqp/all?userId=8"
```

**Workflow Steps:**
1. ✅ Validates eligible ASINs exist
2. ✅ Requests SQP reports from Amazon (types configured in TYPE_ARRAY)
3. ✅ Waits initial delay (default 30s)
4. ✅ Checks report status with retry logic
5. ✅ Downloads completed reports
6. ✅ Saves JSON files to disk
7. ✅ **Imports data to database immediately**
8. ✅ Updates ASIN statuses to "Completed"

#### Individual Operations

```bash
# Request reports only
GET /api/v1/cron/sqp/request

# Check status only  
GET /api/v1/cron/sqp/status

# Download reports only
GET /api/v1/cron/sqp/download

# Process saved JSON files
GET /api/v1/cron/sqp/process-json

# Copy metrics to summary tables
GET /api/v1/cron/sqp/copy-metrics
```

---

### ASIN Sync APIs

```bash
# Sync single seller
GET /api/v1/cron/asin/syncSellerAsins/:userId/:sellerID

# Sync all sellers for user
GET /api/v1/cron/asin/cronSyncAllSellerAsins/:userId

# Sync all users
GET /api/v1/cron/asin/cronSyncAllUsersSellerAsins
```

---

## 🔄 Complete Workflow

```
┌──────────────────────────────────────────────────────────┐
│              SQP Report Workflow                          │
└──────────────────────────────────────────────────────────┘

1. REQUEST PHASE
   ├─ Get eligible ASINs (pending or completed 3+ days ago)
   ├─ Mark ASINs as "Pending"
   ├─ Split ASINs into chunks (max 200 chars)
   ├─ Create report requests (types from TYPE_ARRAY env)
   ├─ Store ReportID in sqp_cron_details
   └─ Wait initial delay (INITIAL_DELAY_SECONDS)

2. STATUS CHECK PHASE
   ├─ Check report processing status
   ├─ States: IN_QUEUE → IN_PROGRESS → DONE
   ├─ Retry with exponential backoff if not ready
   ├─ Store download URL when DONE
   └─ Max attempts: MAX_RETRY_ATTEMPTS

3. DOWNLOAD PHASE
   ├─ Get report document from Amazon
   ├─ Decompress GZIP data
   ├─ Parse JSON (dataByAsin array)
   ├─ Save to: reports/{AmazonSellerID}/{type}/{date}/*.json
   └─ Update sqp_download_urls table

4. IMPORT PHASE (Automatic)
   ├─ Read JSON from disk
   ├─ Parse and validate records
   ├─ Import to sqp_weekly/monthly/quarterly tables
   ├─ Calculate derived metrics (CTR, ACOS, etc.)
   ├─ Update sqp_download_urls (SUCCESS/FAILED)
   └─ Mark cron detail as complete

5. COMPLETION
   ├─ Update ASIN statuses to "Completed"
   ├─ Set EndDate in sqp_cron_details
   ├─ Log activity in sqp_cron_logs
   └─ Send notification if failures occurred
```

### Retry Logic

**Exponential Backoff Strategy:**
- Attempt 1: 30s (base delay)
- Attempt 2: 45s (base + 15s)
- Attempt 3: 60s (base + 30s)
- Max: RETRY_MAX_DELAY_SECONDS (120s default)

**Error Handling:**
- **Transient Errors** → Retry with backoff
- **Permanent Errors** (FATAL/CANCELLED) → Stop immediately
- **Max Retries Reached** → Send email notification
- **Server Errors** → Logged, no crash (global handlers)

---

## 🏗️ Architecture

### Directory Structure

```
mixshift-sqp-api/
├── src/
│   ├── config/           # Configuration files
│   ├── controllers/      # API & cron controllers
│   ├── models/          # Database models
│   ├── services/        # Business logic
│   ├── helpers/         # Reusable helpers
│   ├── middleware/      # Auth, rate limiting, error handling
│   ├── routes/          # API routes
│   ├── spapi/           # Amazon SP-API client
│   ├── utils/           # Utilities (dates, logger, S3)
│   ├── db/              # Multi-tenant DB switching
│   ├── cron/            # Background workers
│   └── server.js        # Express server entry point
├── reports/             # Downloaded JSON files
├── logs/                # Application logs
├── database/            # SQL migration scripts
└── README.md
```

### Key Components

#### Helpers (`src/helpers/sqp.helpers.js`)

**RetryHelpers** - Universal retry with exponential backoff
**DelayHelpers** - Configurable delays with logging
**ValidationHelpers** - Input sanitization
**DateHelpers** - Denver timezone date calculations
**NotificationHelpers** - Email notifications via SMTP

#### Database Tables

- **sqp_cron_details** - Cron job execution tracking
- **sqp_cron_logs** - Detailed activity logs
- **sqp_download_urls** - Download attempts and status
- **sqp_weekly/monthly/quarterly** - Final imported data
- **seller_ASIN_list** - ASIN tracking per seller

---

## 🛡️ Error Handling

### Global Error Handlers

Server includes handlers to prevent crashes:

```javascript
// Unhandled Promise Rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason }, 'Unhandled Promise Rejection');
    // Server continues running
});

// Uncaught Exceptions
process.on('uncaughtException', (error) => {
    logger.error({ error }, 'Uncaught Exception');
    // Server continues running
});
```

### Error Recovery

- **Download Errors** → Logged, retried on next cron run
- **Import Errors** → File preserved, can retry via `/cron/sqp/process-json`
- **API Errors** → Structured responses with status codes

---

## 🚀 Deployment

### Production Setup with PM2

```bash
# Install PM2
npm install -g pm2

# Start application
pm2 start src/server.js --name sqp-api

# Save configuration
pm2 save

# Setup startup script
pm2 startup
```

### Cron Jobs (Linux)

Add to crontab (`crontab -e`):

```cron
# Complete workflow every 6 hours
0 */6 * * * curl -fsS "http://localhost:3001/api/v1/cron/sqp/all" >> /var/log/sqp-all.log 2>&1

# ASIN sync daily at 3 AM
0 3 * * * curl -fsS "http://localhost:3001/api/v1/cron/asin/cronSyncAllUsersSellerAsins" >> /var/log/sqp-asin-sync.log 2>&1
```

### Windows Task Scheduler

- Program: `curl.exe`
- Arguments: `-fsS "http://localhost:3001/api/v1/cron/sqp/all"`
- Schedule: Every 6 hours

---

## 🧪 Testing

### SMTP Test
```bash
node src/scripts/sendTestEmail.js "recipient@example.com" "Test Subject" "Test Body"
```

### Health Checks
```bash
# Health check
curl "http://localhost:3001/healthz"

# Readiness check (with DB test)
curl "http://localhost:3001/readyz"
```

### Manual Cron Test
```bash
curl "http://localhost:3001/api/v1/cron/sqp/all?userId=8"
```

---

## 📊 Monitoring

### Log Locations
- Application: `logs/sqp-api.log`
- Database: `sqp_cron_logs` table
- Execution: `sqp_cron_details` table

### Key Database Queries

**Check recent activity:**
```sql
SELECT * FROM sqp_cron_logs 
WHERE dtCreatedOn > DATE_SUB(NOW(), INTERVAL 1 HOUR)
ORDER BY dtCreatedOn DESC;
```

**Check failed imports:**
```sql
SELECT * FROM sqp_download_urls 
WHERE ProcessStatus = 'FAILED'
ORDER BY dtUpdatedOn DESC;
```

**Check pending ASINs:**
```sql
SELECT * FROM seller_ASIN_list 
WHERE Status = 'Pending'
ORDER BY dtUpdatedOn;
```

---

## 🐛 Troubleshooting

### Common Issues

**1. Import fails after download**
- **Check:** `sqp_download_urls.LastProcessError`
- **Solution:** Run `/cron/sqp/process-json`
- **Verify:** File exists in reports directory

**2. Reports stuck "IN_QUEUE"**
- **Cause:** Amazon still processing
- **Wait:** Status check retries automatically
- **Manual:** Run `/cron/sqp/status`

**3. Server restart issues**
- **Check:** `logs/sqp-api.log` for errors
- **Verify:** All env variables are set
- **Test:** Database connection with `/readyz`

**4. Email notifications not working**
- **Test:** `node src/scripts/sendTestEmail.js`
- **Verify:** SMTP credentials in .env
- **Check:** Firewall/port 587 accessibility

---

## 📝 Recent Improvements

### Version 2.0 Features
- ✅ Immediate import after download (no separate cron needed)
- ✅ Denver timezone support for all date calculations
- ✅ Global error handlers prevent server crashes
- ✅ DelayHelpers class for code deduplication
- ✅ Enhanced retry logic with exponential backoff
- ✅ Download URL tracking in separate table
- ✅ Comprehensive logging at every step
- ✅ Email notifications on max retries
- ✅ Configurable TYPE_ARRAY for report types

### Resolved Issues
- ✅ Fixed "ID has invalid undefined value" error
- ✅ Fixed "DateHelpers.getReportDateForPeriod is not a function"
- ✅ Fixed server crashes on unhandled promise rejections
- ✅ Fixed Sequelize instance spread issues

---

## 🔐 Security & Rate Limiting

### Authentication
Optional token-based (header/query/body)

### Rate Limits
- **SQP APIs:** 100 requests / 15 minutes
- **Cron APIs:** 50 requests / 15 minutes

### CORS
Configured for frontend integration

---

## 📞 Support

For issues:
1. Check `logs/sqp-api.log`
2. Review `sqp_cron_logs` table
3. Contact development team

---

**Version:** 2.0.0  
**Last Updated:** October 1, 2025  
**Node.js:** 12+ required  
**Database:** MySQL 5.7+  
**License:** Proprietary - MixShift LLC

