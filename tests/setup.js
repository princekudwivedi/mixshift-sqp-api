// Test setup file
const path = require('path');

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'error'; // Reduce log noise during tests

// Mock logger to prevent console output during tests
jest.mock('../src/utils/logger.utils', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Global test timeout
jest.setTimeout(30000);

// Cleanup after each test
afterEach(() => {
    jest.clearAllMocks();
});

// Global teardown
afterAll(() => {
    // Clean up any global resources
});
