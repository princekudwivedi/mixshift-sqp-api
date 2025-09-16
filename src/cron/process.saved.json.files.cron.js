#!/usr/bin/env node

/**
 * SQP Saved JSON File Processing Cron Job
 * 
 * This script processes JSON files that are already saved to disk
 * and stores the data in the sqp_metrics_3mo table
 * 
 * Usage: node cron/processSavedJsonFiles.js [userId]
 * 
 * Example: node cron/processSavedJsonFiles.js 3
 */

require('dotenv').config();
const sqpFileProcessingService = require('../src/services/sqpFileProcessingService');

async function main() {
    const userId = process.argv[2];
    
    if (!userId) {
        console.error('Error: User ID is required');
        console.error('Usage: node cron/processSavedJsonFiles.js [userId]');
        console.error('Example: node cron/processSavedJsonFiles.js 3');
        process.exit(1);
    }

    // Set user ID in environment
    process.env.USER_ID = userId;

    console.log(`Starting SQP Saved JSON File Processing Cron Job for User ${userId}`);
    const startTime = Date.now();

    try {
        const result = await sqpFileProcessingService.processSavedJsonFiles();
        
        const executionTime = (Date.now() - startTime) / 1000;
        console.log(`SQP Saved JSON File Processing Cron Job completed successfully in ${executionTime.toFixed(2)} seconds`);
        console.log(`Processed: ${result.processed} files, Errors: ${result.errors}`);
        
        // Get and display stats
        const stats = await sqpFileProcessingService.getProcessingStats();
        console.log('Processing Statistics:');
        console.log(`- Total Downloads: ${stats.downloads.total_downloads}`);
        console.log(`- Files Ready: ${stats.downloads.files_ready}`);
        console.log(`- Pending: ${stats.downloads.pending}`);
        console.log(`- Failed: ${stats.downloads.failed}`);
        console.log(`- Total Records in sqp_metrics_3mo: ${stats.metrics.total_records}`);
        
    } catch (error) {
        console.error('SQP Saved JSON File Processing Cron Job failed:', error.message);
        process.exit(1);
    }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    process.exit(1);
});

main();
