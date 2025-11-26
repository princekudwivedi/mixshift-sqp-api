const { 
    RetryHelpers, 
    ValidationHelpers, 
    DateHelpers, 
    FileHelpers, 
    DelayHelpers,
    CircuitBreaker,
    RateLimiter,
    MemoryMonitor
} = require('../src/helpers/sqp.helpers');

describe('Cron Integration Tests', () => {
    
    describe('Error Handling and Recovery', () => {
        test('should handle network timeouts gracefully', async () => {
            const mockModel = {
                getRetryCount: jest.fn().mockResolvedValue(0),
                incrementRetryCount: jest.fn().mockResolvedValue(true),
                logCronActivity: jest.fn().mockResolvedValue(true),
                updateSQPReportStatus: jest.fn().mockResolvedValue(true)
            };
            
            const networkError = new Error('Network timeout');
            networkError.code = 'ETIMEDOUT';
            
            const mockOperation = jest.fn().mockRejectedValue(networkError);
            
            const result = await RetryHelpers.executeWithRetry({
                cronDetailID: 1,
                amazonSellerID: 'test-seller',
                reportType: 'WEEK',
                action: 'Network Test',
                operation: mockOperation,
                model: mockModel,
                maxRetries: 2
            });
            
            expect(result.success).toBe(false);
            expect(result.finalFailure).toBe(true);
            expect(mockOperation).toHaveBeenCalledTimes(2);
        });
        
        test('should handle authentication errors without retry', async () => {
            const mockModel = {
                getRetryCount: jest.fn().mockResolvedValue(0),
                incrementRetryCount: jest.fn().mockResolvedValue(true),
                logCronActivity: jest.fn().mockResolvedValue(true),
                updateSQPReportStatus: jest.fn().mockResolvedValue(true)
            };
            
            const authError = new Error('Invalid access token');
            authError.status = 401;
            
            const mockOperation = jest.fn().mockRejectedValue(authError);
            
            const result = await RetryHelpers.executeWithRetry({
                cronDetailID: 1,
                amazonSellerID: 'test-seller',
                reportType: 'WEEK',
                action: 'Auth Test',
                operation: mockOperation,
                model: mockModel
            });
            
            expect(result.success).toBe(false);
            expect(result.nonRetryable).toBe(true);
            expect(mockOperation).toHaveBeenCalledTimes(1); // Should not retry
        });
    });
    
    describe('Memory Management', () => {
        test('should monitor memory usage during operations', () => {
            const initialStats = MemoryMonitor.getMemoryStats();
            expect(initialStats.heapUsed).toBeGreaterThan(0);
            
            // Simulate some memory usage
            const largeArray = new Array(10000).fill('test data');
            
            const afterStats = MemoryMonitor.getMemoryStats();
            expect(afterStats.heapUsed).toBeGreaterThanOrEqual(initialStats.heapUsed);
            
            // Clean up
            largeArray.length = 0;
        });
        
        test('should detect high memory usage', () => {
            const isHigh = MemoryMonitor.isMemoryUsageHigh(1); // 1MB threshold for testing
            expect(typeof isHigh).toBe('boolean');
        });
    });
    
    describe('Rate Limiting Integration', () => {
        test('should respect rate limits across multiple operations', async () => {
            const rateLimiter = new RateLimiter(3, 1000); // 3 requests per second
            
            try {
                // Should allow first 3 requests
                await rateLimiter.checkLimit('test-user');
                await rateLimiter.checkLimit('test-user');
                await rateLimiter.checkLimit('test-user');
                
                // 4th request should be rate limited
                await expect(rateLimiter.checkLimit('test-user')).rejects.toThrow('Rate limit exceeded');
                
                // Different user should still be allowed
                await expect(rateLimiter.checkLimit('other-user')).resolves.not.toThrow();
                
            } finally {
                rateLimiter.destroy();
            }
        });
    });
    
    describe('Circuit Breaker Integration', () => {
        test('should protect against cascading failures', async () => {
            const circuitBreaker = new CircuitBreaker(2, 1000);
            
            try {
                const failingOperation = jest.fn().mockRejectedValue(new Error('Service down'));
                
                // First two failures should open the circuit
                await expect(circuitBreaker.execute(failingOperation)).rejects.toThrow();
                await expect(circuitBreaker.execute(failingOperation)).rejects.toThrow();
                
                // Third call should be blocked by circuit breaker
                await expect(circuitBreaker.execute(failingOperation)).rejects.toThrow('Circuit breaker is OPEN');
                
                // Verify the operation was only called twice (not three times)
                expect(failingOperation).toHaveBeenCalledTimes(2);
                
            } finally {
                circuitBreaker.reset();
            }
        });
        
        test('should recover after service restoration', async () => {
            const circuitBreaker = new CircuitBreaker(2, 1000);
            
            try {
                let callCount = 0;
                const recoveringOperation = jest.fn().mockImplementation(() => {
                    callCount++;
                    if (callCount <= 2) {
                        throw new Error('Service down');
                    }
                    return 'Service restored';
                });
                
                // Open the circuit
                await expect(circuitBreaker.execute(recoveringOperation)).rejects.toThrow();
                await expect(circuitBreaker.execute(recoveringOperation)).rejects.toThrow();
                
                // Wait for circuit to reset
                await new Promise(resolve => setTimeout(resolve, 1100));
                
                // Should succeed on retry
                const result = await circuitBreaker.execute(recoveringOperation);
                expect(result).toBe('Service restored');
                
            } finally {
                circuitBreaker.reset();
            }
        });
    });
    
    describe('Data Validation Integration', () => {
        test('should validate and sanitize user inputs', () => {
            const maliciousInput = '<script>alert("xss")</script>; DROP TABLE users; --';
            const sanitized = ValidationHelpers.sanitizeString(maliciousInput);
            
            expect(sanitized).not.toContain('<script>');
            expect(sanitized).not.toContain(';');  // Semicolon should be removed
            expect(sanitized).not.toContain('--'); // Double dash should be removed
            expect(sanitized.length).toBeLessThan(maliciousInput.length); // Should be shorter after sanitization
        });
        
        test('should handle invalid user IDs gracefully', () => {
            expect(() => ValidationHelpers.validateUserId('0')).toThrow('Invalid user ID: must be between 1 and 999999999');
            expect(() => ValidationHelpers.validateUserId('-1')).toThrow('Invalid user ID: must be between 1 and 999999999');
            expect(() => ValidationHelpers.validateUserId('invalid')).toThrow('Invalid user ID: must be between 1 and 999999999');
            expect(() => ValidationHelpers.validateUserId('1000000000')).toThrow('Invalid user ID: must be between 1 and 999999999');
        });
        
        test('should validate email addresses properly', () => {
            expect(ValidationHelpers.validateEmail('test@example.com')).toBe('test@example.com');
            expect(() => ValidationHelpers.validateEmail('invalid-email')).toThrow('Invalid email format');
            expect(() => ValidationHelpers.validateEmail('')).toThrow('Email is required');
        });
    });
    
    describe('Date Handling Integration', () => {
        test('should handle different timezones correctly', () => {
            const weekDate = DateHelpers.getReportDateForPeriod('WEEK', 'America/New_York');
            const monthDate = DateHelpers.getReportDateForPeriod('MONTH', 'America/Los_Angeles');
            
            expect(weekDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(monthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });
        
        test('should validate date ranges correctly', () => {
            const validRange = DateHelpers.getDateRange('2023-01-01', '2023-01-31');
            expect(validRange.days).toBe(31);
            
            expect(() => DateHelpers.getDateRange('2023-01-31', '2023-01-01')).toThrow('Start date cannot be after end date');
        });
    });
    
    describe('File Operations Integration', () => {
        const testDir = require('node:path').join(__dirname, 'integration-test-files');
        const testFile = require('node:path').join(testDir, 'integration-test.json');
        
        beforeAll(async () => {
            const fs = require('node:fs').promises;
            await fs.mkdir(testDir, { recursive: true });
            await fs.writeFile(testFile, JSON.stringify({ 
                test: 'integration data',
                timestamp: new Date().toISOString()
            }));
        });
        
        afterAll(async () => {
            const fs = require('node:fs').promises;
            await fs.rm(testDir, { recursive: true, force: true });
        });
        
        test('should handle file operations safely', async () => {
            // Test file existence
            expect(await FileHelpers.fileExists(testFile)).toBe(true);
            expect(await FileHelpers.fileExists('non-existent.json')).toBe(false);
            
            // Test file reading
            const data = await FileHelpers.readJsonFile(testFile);
            expect(data.test).toBe('integration data');
            
            // Test file size
            const size = await FileHelpers.getFileSize(testFile);
            expect(size).toBeGreaterThan(0);
        });
        
        test('should reject malicious file paths', () => {
            expect(() => FileHelpers.validateFilePath('../etc/passwd')).toThrow('path traversal detected');
            expect(() => FileHelpers.validateFilePath('/etc/passwd')).toThrow('restricted directory');
            expect(() => FileHelpers.validateFilePath('../../../etc/passwd')).toThrow('path traversal detected');
        });
    });
    
    describe('Performance and Load Testing', () => {
        test('should handle multiple concurrent operations', async () => {
            const rateLimiter = new RateLimiter(100, 1000); // 100 requests per second
            const circuitBreaker = new CircuitBreaker(10, 1000);
            
            try {
                const operations = [];
                const startTime = Date.now();
                
                // Create 50 concurrent operations
                for (let i = 0; i < 50; i++) {
                    operations.push(
                        rateLimiter.checkLimit(`user-${i % 10}`) // 10 different users
                    );
                }
                
                await Promise.all(operations);
                
                const endTime = Date.now();
                const duration = endTime - startTime;
                
                // Should complete quickly (within 1 second)
                expect(duration).toBeLessThan(1000);
                
            } finally {
                rateLimiter.destroy();
                circuitBreaker.reset();
            }
        });
        
        test('should handle memory pressure gracefully', () => {
            const initialMemory = MemoryMonitor.getMemoryStats();
            
            // Create some memory pressure
            const arrays = [];
            for (let i = 0; i < 100; i++) {
                arrays.push(new Array(1000).fill(`data-${i}`));
            }
            
            const afterMemory = MemoryMonitor.getMemoryStats();
            expect(afterMemory.heapUsed).toBeGreaterThanOrEqual(initialMemory.heapUsed);
            
            // Clean up
            for (const arr of arrays) {
                arr.length = 0;
            }
            arrays.length = 0;
            
            // Force garbage collection if available
            if (globalThis.gc) {
                globalThis.gc();
            } 
        });
    });
    
    describe('Error Recovery Scenarios', () => {
        test('should recover from temporary service outages', async () => {
            const circuitBreaker = new CircuitBreaker(3, 2000); // 3 failures, 2 second timeout
            
            try {
                let attemptCount = 0;
                const recoveringService = jest.fn().mockImplementation(() => {
                    attemptCount++;
                    if (attemptCount <= 3) {
                        throw new Error('Service temporarily unavailable');
                    }
                    return 'Service recovered';
                });
                
                // First three attempts should fail and open circuit
                await expect(circuitBreaker.execute(recoveringService)).rejects.toThrow();
                await expect(circuitBreaker.execute(recoveringService)).rejects.toThrow();
                await expect(circuitBreaker.execute(recoveringService)).rejects.toThrow();
                
                // Circuit should be open
                expect(circuitBreaker.getState().state).toBe('OPEN');
                
                // Wait for circuit to reset
                await new Promise(resolve => setTimeout(resolve, 2100));
                
                // Should succeed on retry
                const result = await circuitBreaker.execute(recoveringService);
                expect(result).toBe('Service recovered');
                
            } finally {
                circuitBreaker.reset();
            }
        });
        
        test('should handle mixed error types correctly', async () => {
            const mockModel = {
                getRetryCount: jest.fn().mockResolvedValue(0),
                incrementRetryCount: jest.fn().mockResolvedValue(true),
                logCronActivity: jest.fn().mockResolvedValue(true),
                updateSQPReportStatus: jest.fn().mockResolvedValue(true)
            };
            
            const errors = [
                new Error('Network timeout'), // Retryable
                new Error('Invalid token'),   // Non-retryable
                new Error('Service unavailable') // Retryable
            ];
            
            for (const error of errors) {
                const mockOperation = jest.fn().mockRejectedValue(error);
                
                const result = await RetryHelpers.executeWithRetry({
                    cronDetailID: 1,
                    amazonSellerID: 'test-seller',
                    reportType: 'WEEK',
                    action: 'Mixed Error Test',
                    operation: mockOperation,
                    model: mockModel
                });
                
                if (RetryHelpers.isRetryableError(error)) {
                    expect(result.success).toBe(false);
                    expect(result.finalFailure).toBe(true);
                } else {
                    expect(result.success).toBe(false);
                    expect(result.nonRetryable).toBe(true);
                }
            }
        });
    });
});
