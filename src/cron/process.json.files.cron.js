#!/usr/bin/env node

/**
 * SQP JSON File Processing Cron Job
 * 
 * This script processes pending JSON files from download URLs
 * and stores the data in the sqp_report_data table
 * 
 * Usage: node cron/processJsonFiles.js [userId]
 * 
 * Example: node cron/processJsonFiles.js 3
 */

require('dotenv').config();
const sqpJsonProcessingService = require('../src/services/sqpJsonProcessingService');

async function main() {
    const userId = process.argv[2];
    
    if (!userId) {
        console.error('Error: User ID is required');
        console.error('Usage: node cron/processJsonFiles.js [userId]');
        console.error('Example: node cron/processJsonFiles.js 3');
        process.exit(1);
    }

    // Set user ID in environment
    process.env.USER_ID = userId;

    console.log(`Starting SQP JSON File Processing Cron Job for User ${userId}`);
    const startTime = Date.now();

    try {
        await sqpJsonProcessingService.processPendingJsonFiles();
        
        const executionTime = (Date.now() - startTime) / 1000;
        console.log(`SQP JSON File Processing Cron Job completed successfully in ${executionTime.toFixed(2)} seconds`);
        
    } catch (error) {
        console.error('SQP JSON File Processing Cron Job failed:', error.message);
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
