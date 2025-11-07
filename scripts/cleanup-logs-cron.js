#!/usr/bin/env node
/**
 * Cron Script - Clean Old Logs
 * Automatically removes log folders older than specified days
 * 
 * Cleans both:
 * - Root date folders: logs/<DD-MM-YYYY>/
 * - API user logs: logs/api_logs/user_X/<DD-MM-YYYY>/
 * 
 * Usage:
 *   node scripts/cleanup-logs-cron.js
 * 
 * Schedule with PM2:
 *   Add to ecosystem.config.js with cron_restart: "0 2 * * *"
 * 
 * Environment Variables:
 *   LOG_CLEANUP_DAYS - Days to keep (default: 30)
 *   LOG_TO_FILE - Must be 'true' for cleanup to run
 */

require('dotenv').config();
const apiLogger = require('../src/utils/api.logger.utils');

// Configuration from environment
const DAYS_TO_KEEP = parseInt(process.env.LOG_CLEANUP_DAYS) || 30;

console.log('═'.repeat(60));
console.log('LOG CLEANUP CRON JOB');
console.log('═'.repeat(60));
console.log(`Started at: ${new Date().toISOString()}`);
console.log(`Days to keep: ${DAYS_TO_KEEP}`);
console.log('═'.repeat(60));

try {
	// Run cleanup for BOTH:
	// - Root date folders: logs/<DD-MM-YYYY>/
	// - API user logs: logs/api_logs/user_X/<DD-MM-YYYY>/
	apiLogger.cleanOldLogs(DAYS_TO_KEEP);
	
	console.log('═'.repeat(60));
	console.log(`✅ Cleanup job completed successfully`);
	console.log(`Finished at: ${new Date().toISOString()}`);
	console.log('═'.repeat(60));
	
	process.exit(0);
} catch (error) {
	console.error('═'.repeat(60));
	console.error('❌ Cleanup job failed:', error.message);
	console.error(error.stack);
	console.error('═'.repeat(60));
	
	process.exit(1);
}

