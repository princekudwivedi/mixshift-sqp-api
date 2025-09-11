## Dash Amazon SP-API Node Cron

This Node.js project ports the SQP cron flow from `dash-amazon-sp-api/application/controllers/SQP_Cron_Controller.php` into Node, with equivalent request, status check, download, and processing steps.

### Quick start

1. Create env file
```
cp .env.sample .env
```
2. Fill DB, AWS, and SP-API/LWA values in `.env`.
3. Run any cron:
```
npm run cron:request
npm run cron:status
npm run cron:download
npm run cron:all
```

### Structure

- `src/config/env.ts` – loads env and constants
- `src/utils/logger.ts` – pino logger
- `src/utils/dates.ts` – date calculations for WEEK/MONTH/QUARTER
- `src/db/mysql.ts` – MySQL pool
- `src/models/sqpCronModel.ts` – DB operations mirrored from PHP model
- `src/spapi/client.ts` – signed SP-API requests
- `src/controllers/sqpCronController.ts` – cron flows
- `src/cli/*.ts` – CLI entry points

### Notes

- Table names are configurable via env to match your schema.
- Seller and user discovery can be wired to your existing DB once available. For now, you can set a seller profile via env.


