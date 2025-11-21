const { 
    RetryHelpers, 
    ValidationHelpers, 
    DateHelpers, 
    FileHelpers, 
    DataProcessingHelpers, 
    DelayHelpers,
    CircuitBreaker,
    RateLimiter,
    MemoryMonitor
} = require('../src/helpers/sqp.helpers');
const fs = require('node:fs').promises;
const path = require('node:path');

describe('Helper Methods Tests', () => {
    
    describe('RetryHelpers', () => {
        let mockModel;
        
        beforeEach(() => {
            mockModel = {
                getRetryCount: jest.fn().mockResolvedValue(0),
                incrementRetryCount: jest.fn().mockResolvedValue(true),
                logCronActivity: jest.fn().mockResolvedValue(true),
                updateSQPReportStatus: jest.fn().mockResolvedValue(true)
            };
        });
        
        test('should classify retryable errors correctly', () => {
            const retryableErrors = [
                new Error('Network timeout'),
                new Error('Connection refused'),
                new Error('Rate limit exceeded'),
                new Error('Service temporarily unavailable'),
                { message: 'Internal server error', status: 500 },
                { message: 'Gateway timeout', statusCode: 504 }
            ];
            
            retryableErrors.forEach(error => {
                expect(RetryHelpers.isRetryableError(error)).toBe(true);
            });
        });
        
        test('should classify non-retryable errors correctly', () => {
            const nonRetryableErrors = [
                new Error('Invalid token'),
                new Error('Unauthorized access'),
                new Error('Not found'),
                new Error('Bad request'),
                new Error('Validation error'),
                { message: 'Forbidden', status: 403 },
                { message: 'Not found', statusCode: 404 }
            ];
            
            nonRetryableErrors.forEach(error => {
                expect(RetryHelpers.isRetryableError(error)).toBe(false);
            });
        });
        
        test('should execute operation successfully on first attempt', async () => {
            const mockOperation = jest.fn().mockResolvedValue({ message: 'Success' });
            
            const result = await RetryHelpers.executeWithRetry({
                cronDetailID: 1,
                amazonSellerID: 'test-seller',
                reportType: 'WEEK',
                action: 'Test Action',
                operation: mockOperation,
                model: mockModel
            });
            
            expect(result.success).toBe(true);
            expect(result.attempt).toBe(1);
            expect(mockOperation).toHaveBeenCalledTimes(1);
        });
        
        test('should retry on retryable errors', async () => {
            const mockOperation = jest.fn()
                .mockRejectedValueOnce(new Error('Network timeout'))
                .mockResolvedValue({ message: 'Success' });
            
            const result = await RetryHelpers.executeWithRetry({
                cronDetailID: 1,
                amazonSellerID: 'test-seller',
                reportType: 'WEEK',
                action: 'Test Action',
                operation: mockOperation,
                model: mockModel,
                maxRetries: 2
            });
            
            expect(result.success).toBe(true);
            expect(result.attempt).toBe(2);
            expect(mockOperation).toHaveBeenCalledTimes(2);
        });
        
        test('should fail immediately on non-retryable errors', async () => {
            const mockOperation = jest.fn().mockRejectedValue(new Error('Invalid token'));
            
            const result = await RetryHelpers.executeWithRetry({
                cronDetailID: 1,
                amazonSellerID: 'test-seller',
                reportType: 'WEEK',
                action: 'Test Action',
                operation: mockOperation,
                model: mockModel
            });
            
            expect(result.success).toBe(false);
            expect(result.nonRetryable).toBe(true);
            expect(mockOperation).toHaveBeenCalledTimes(1);
        });
    });
    
    describe('ValidationHelpers', () => {
        test('should sanitize string input correctly', () => {
            expect(ValidationHelpers.sanitizeString('  test<script>alert("xss")</script>  '))
                .toBe('testscriptalertxssscript');
            expect(ValidationHelpers.sanitizeString('test; DROP TABLE users; --'))
                .toBe('test DROP TABLE users');
            expect(ValidationHelpers.sanitizeString('normal@email.com'))
                .toBe('normal@email.com');
        });
        
        test('should validate and sanitize numbers with bounds', () => {
            expect(ValidationHelpers.sanitizeNumber('123', 0, 1, 1000)).toBe(123);
            expect(ValidationHelpers.sanitizeNumber('1500', 0, 1, 1000)).toBe(1000);
            expect(ValidationHelpers.sanitizeNumber('-5', 0, 1, 1000)).toBe(1);
            expect(ValidationHelpers.sanitizeNumber('invalid', 0, 1, 1000)).toBe(0);
        });
        
        test('should validate user IDs correctly', () => {
            expect(ValidationHelpers.validateUserId('123')).toBe(123);
            expect(ValidationHelpers.validateUserId('999999999')).toBe(999999999);
            
            expect(() => ValidationHelpers.validateUserId('0')).toThrow('Invalid user ID: must be between 1 and 999999999');
            expect(() => ValidationHelpers.validateUserId('1000000000')).toThrow('Invalid user ID: must be between 1 and 999999999');
            expect(() => ValidationHelpers.validateUserId('invalid')).toThrow('Invalid user ID: must be between 1 and 999999999');
        });
        
        test('should validate email addresses correctly', () => {
            expect(ValidationHelpers.validateEmail('test@example.com')).toBe('test@example.com');
            expect(ValidationHelpers.validateEmail('TEST@EXAMPLE.COM')).toBe('test@example.com');
            
            expect(() => ValidationHelpers.validateEmail('invalid-email')).toThrow('Invalid email format');
            expect(() => ValidationHelpers.validateEmail('')).toThrow('Email is required');
        });
        
        test('should validate required fields', () => {
            const obj = { name: 'test', email: 'test@example.com', age: 25 };
            
            expect(() => ValidationHelpers.validateRequiredFields(obj, ['name', 'email'])).not.toThrow();
            expect(() => ValidationHelpers.validateRequiredFields(obj, ['name', 'missing'])).toThrow('Missing required fields: missing');
        });
    });
    
    describe('DateHelpers', () => {
        test('should get report date for different periods', () => {
            const weekDate = DateHelpers.getReportDateForPeriod('WEEK');
            const monthDate = DateHelpers.getReportDateForPeriod('MONTH');
            const quarterDate = DateHelpers.getReportDateForPeriod('QUARTER');
            
            expect(weekDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(monthDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
            expect(quarterDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });
        
        test('should handle invalid report types gracefully', () => {
            const result = DateHelpers.getReportDateForPeriod('INVALID');
            expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        });
        
        test('should validate date strings', () => {
            expect(() => DateHelpers.validateDateString('2023-12-25')).not.toThrow();
            expect(() => DateHelpers.validateDateString('invalid-date')).toThrow('Invalid date format');
            expect(() => DateHelpers.validateDateString('')).toThrow('Date string is required');
        });
        
        test('should get date range with validation', () => {
            const range = DateHelpers.getDateRange('2023-01-01', '2023-01-31');
            expect(range.start).toBe('2023-01-01');
            expect(range.end).toBe('2023-01-31');
            expect(range.days).toBe(31);
            
            expect(() => DateHelpers.getDateRange('2023-01-31', '2023-01-01')).toThrow('Start date cannot be after end date');
        });
    });
    
    describe('FileHelpers', () => {
        const testDir = path.join(__dirname, 'test-files');
        const testFile = path.join(testDir, 'test.json');
        
        beforeAll(async () => {
            await fs.mkdir(testDir, { recursive: true });
            await fs.writeFile(testFile, JSON.stringify({ test: 'data' }));
        });
        
        afterAll(async () => {
            await fs.rm(testDir, { recursive: true, force: true });
        });
        
        test('should check if file exists', async () => {
            expect(await FileHelpers.fileExists(testFile)).toBe(true);
            expect(await FileHelpers.fileExists('non-existent-file.json')).toBe(false);
        });
        
        test('should read JSON file safely', async () => {
            const data = await FileHelpers.readJsonFile(testFile);
            expect(data).toEqual({ test: 'data' });
        });
        
        test('should reject files that are too large', async () => {
            const largeFile = path.join(testDir, 'large.json');
            const largeData = 'x'.repeat(1024 * 1024 * 2); // 2MB
            await fs.writeFile(largeFile, JSON.stringify({ data: largeData }));
            
            await expect(FileHelpers.readJsonFile(largeFile, 1)).rejects.toThrow('File too large');
            
            await fs.unlink(largeFile);
        });
        
        test('should reject non-JSON files', async () => {
            const txtFile = path.join(testDir, 'test.txt');
            await fs.writeFile(txtFile, 'not json');
            
            await expect(FileHelpers.readJsonFile(txtFile)).rejects.toThrow('File must be JSON format');
            
            await fs.unlink(txtFile);
        });
        
        test('should validate file paths for security', () => {
            expect(() => FileHelpers.validateFilePath('normal/path/file.json')).not.toThrow();
            expect(() => FileHelpers.validateFilePath('../etc/passwd')).toThrow('path traversal detected');
            expect(() => FileHelpers.validateFilePath('/etc/passwd')).toThrow('restricted directory');
        });
        
        test('should get file size', async () => {
            const size = await FileHelpers.getFileSize(testFile);
            expect(size).toBeGreaterThan(0);
        });
    });
    
    describe('DataProcessingHelpers', () => {
        test('should extract records from different JSON structures', () => {
            const arrayData = [{ asin: 'B123' }, { asin: 'B456' }];
            const objectData = { records: [{ asin: 'B123' }] };
            const sqpData = { dataByAsin: [{ asin: 'B123' }] };
            
            expect(DataProcessingHelpers.extractRecords(arrayData)).toEqual(arrayData);
            expect(DataProcessingHelpers.extractRecords(objectData)).toEqual([{ asin: 'B123' }]);
            expect(DataProcessingHelpers.extractRecords(sqpData)).toEqual([{ asin: 'B123' }]);
        });
        
        test('should calculate derived metrics correctly', () => {
            const record = {
                impressionData: { asinImpressionCount: 1000 },
                clickData: { asinClickCount: 100, asinMedianClickPrice: { amount: 0.5 } },
                purchaseData: { asinPurchaseCount: 10, asinMedianPurchasePrice: { amount: 25.0 } }
            };
            
            const metrics = DataProcessingHelpers.calculateDerivedMetrics(record);
            expect(metrics.clickThroughRate).toBe(10); // 100/1000 * 100
            expect(metrics.spend).toBe(50); // 100 * 0.5
            expect(metrics.sales).toBe(250); // 10 * 25
            expect(metrics.acos).toBe(20); // 50/250 * 100
            expect(metrics.conversionRate).toBe(10); // 10/100 * 100
        });
        
        test('should validate SQP record structure', () => {
            const validRecord = { asin: 'B123' };
            const invalidRecord = { name: 'test' };
            
            expect(() => DataProcessingHelpers.validateSqpRecord(validRecord)).not.toThrow();
            expect(() => DataProcessingHelpers.validateSqpRecord(invalidRecord)).toThrow('Missing required fields: asin');
        });
    });
    
    describe('DelayHelpers', () => {
        test('should wait for specified time', async () => {
            const start = Date.now();
            await DelayHelpers.wait(0.1); // 100ms
            const end = Date.now();
            
            expect(end - start).toBeGreaterThanOrEqual(90); // Allow some tolerance
        });
        
        test('should cap excessive wait times', async () => {
            const start = Date.now();
            await DelayHelpers.wait(600); // 10 minutes - should be capped to 5 minutes
            const end = Date.now();
            
            expect(end - start).toBeLessThan(310000); // Should be less than 5 minutes + tolerance
        }, 350000); // 5 minutes + 50 seconds timeout
        
        test('should calculate backoff delay correctly', () => {
            const delay1 = DelayHelpers.calculateBackoffDelay(1);
            const delay2 = DelayHelpers.calculateBackoffDelay(2);
            const delay3 = DelayHelpers.calculateBackoffDelay(3);
            
            expect(delay2).toBeGreaterThan(delay1);
            expect(delay3).toBeGreaterThan(delay2);
        });
    });
    
    describe('CircuitBreaker', () => {
        let circuitBreaker;
        
        beforeEach(() => {
            circuitBreaker = new CircuitBreaker(2, 1000); // 2 failures, 1 second timeout
        });
        
        test('should execute successful operations', async () => {
            const mockOperation = jest.fn().mockResolvedValue('success');
            
            const result = await circuitBreaker.execute(mockOperation);
            expect(result).toBe('success');
            expect(circuitBreaker.getState().state).toBe('CLOSED');
        });
        
        test('should open circuit after threshold failures', async () => {
            const mockOperation = jest.fn().mockRejectedValue(new Error('Service error'));
            
            // First two failures
            await expect(circuitBreaker.execute(mockOperation)).rejects.toThrow();
            await expect(circuitBreaker.execute(mockOperation)).rejects.toThrow();
            
            // Circuit should be open now
            expect(circuitBreaker.getState().state).toBe('OPEN');
            
            // Third call should fail immediately
            await expect(circuitBreaker.execute(mockOperation)).rejects.toThrow('Circuit breaker is OPEN');
        });
        
        test('should transition to half-open after timeout', async () => {
            const mockOperation = jest.fn().mockRejectedValue(new Error('Service error'));
            
            // Open the circuit
            await expect(circuitBreaker.execute(mockOperation)).rejects.toThrow();
            await expect(circuitBreaker.execute(mockOperation)).rejects.toThrow();
            
            expect(circuitBreaker.getState().state).toBe('OPEN');
            
            // Wait for timeout
            await new Promise(resolve => setTimeout(resolve, 1100));
            
            // Attempt an operation - this should trigger transition to HALF_OPEN
            const mockOperationAfterTimeout = jest.fn().mockResolvedValue('success');
            await circuitBreaker.execute(mockOperationAfterTimeout);
            
            // Should transition to half-open
            expect(circuitBreaker.getState().state).toBe('HALF_OPEN');
        });
    });
    
    describe('RateLimiter', () => {
        let rateLimiter;
        
        beforeEach(() => {
            rateLimiter = new RateLimiter(2, 1000); // 2 requests per second
        });
        
        afterEach(() => {
            rateLimiter.destroy();
        });
        
        test('should allow requests within limit', async () => {
            await expect(rateLimiter.checkLimit('user1')).resolves.not.toThrow();
            await expect(rateLimiter.checkLimit('user1')).resolves.not.toThrow();
        });
        
        test('should reject requests exceeding limit', async () => {
            await rateLimiter.checkLimit('user1');
            await rateLimiter.checkLimit('user1');
            
            await expect(rateLimiter.checkLimit('user1')).rejects.toThrow('Rate limit exceeded');
        });
        
        test('should track different users separately', async () => {
            await rateLimiter.checkLimit('user1');
            await rateLimiter.checkLimit('user1');
            
            // user2 should still be able to make requests
            await expect(rateLimiter.checkLimit('user2')).resolves.not.toThrow();
        });
        
        test('should provide stats', async () => {
            await rateLimiter.checkLimit('user1');
            
            const stats = rateLimiter.getStats('user1');
            expect(stats.requests).toBe(1);
            expect(stats.remaining).toBe(1);
        });
    });
    
    describe('MemoryMonitor', () => {
        test('should get memory stats', () => {
            const stats = MemoryMonitor.getMemoryStats();
            
            expect(stats).toHaveProperty('heapUsed');
            expect(stats).toHaveProperty('heapTotal');
            expect(stats).toHaveProperty('external');
            expect(stats).toHaveProperty('rss');
            expect(stats).toHaveProperty('arrayBuffers');
            
            expect(typeof stats.heapUsed).toBe('number');
            expect(typeof stats.heapTotal).toBe('number');
        });
        
        test('should check if memory usage is high', () => {
            const isHigh = MemoryMonitor.isMemoryUsageHigh(1); // 1MB threshold for testing
            expect(typeof isHigh).toBe('boolean');
        });
    });
});

// Integration tests
describe('Integration Tests', () => {
    test('should handle complete retry flow with circuit breaker', async () => {
        const circuitBreaker = new CircuitBreaker(2, 1000);
        const rateLimiter = new RateLimiter(10, 60000);
        
        let attemptCount = 0;
        const mockOperation = async () => {
            attemptCount++;
            if (attemptCount <= 2) {
                throw new Error('Temporary failure');
            }
            return 'success';
        };
        
        // First two attempts should fail and open circuit
        await expect(circuitBreaker.execute(mockOperation)).rejects.toThrow();
        await expect(circuitBreaker.execute(mockOperation)).rejects.toThrow();
        
        // Third attempt should be blocked by circuit breaker
        await expect(circuitBreaker.execute(mockOperation)).rejects.toThrow('Circuit breaker is OPEN');
        
        // Wait for circuit to reset
        await new Promise(resolve => setTimeout(resolve, 1100));
        
        // Should succeed on retry
        const result = await circuitBreaker.execute(mockOperation);
        expect(result).toBe('success');
        
        circuitBreaker.reset();
        rateLimiter.destroy();
    });
    
    test('should handle rate limiting with retry logic', async () => {
        const rateLimiter = new RateLimiter(2, 1000);
        
        // Fill up the rate limit
        await rateLimiter.checkLimit('test-user');
        await rateLimiter.checkLimit('test-user');
        
        // Third request should be rate limited
        await expect(rateLimiter.checkLimit('test-user')).rejects.toThrow('Rate limit exceeded');
        
        rateLimiter.destroy();
    });
});
