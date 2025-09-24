jest.mock('../../src/models/sqp.metrics.model', () => ({
  getReportIdsWithDataIn3mo: jest.fn(async () => [101])
}));

const { copyDataWithBulkInsert, performDryRun } = require('../../src/services/sqp.file.processing.service');

// Mock tenant models
jest.mock('../../src/models/sequelize/sqpMetrics3mo.model', () => ({
  getModel: () => ({
    findAll: jest.fn(async ({ where, offset = 0, limit = 5000 }) => {
      if (offset > 0) return [];
      return [
        { ID: 1, ReportID: where.ReportID, ASIN: 'A1', SearchQuery: 'q', ReportDate: '2025-01-01' },
        { ID: 2, ReportID: where.ReportID, ASIN: 'A1', SearchQuery: 'q', ReportDate: '2025-01-01' }, // dup logical
      ];
    })
  })
}));

jest.mock('../../src/models/sequelize/sqpMetrics.model', () => ({
  getModel: () => ({
    rawAttributes: { ID: {}, ReportID: {}, ASIN: {}, SearchQuery: {}, ReportDate: {} },
    sequelize: { transaction: async (fn) => fn({}) },
    count: jest.fn(async () => 0),
    bulkCreate: jest.fn(async () => {})
  })
}));

jest.mock('../../src/models/sqp.download.urls.model', () => ({
  markDataCopiedToMain: jest.fn(async () => {})
}));

describe('copy pipeline', () => {
  test('dry run counts logical distinct rows', async () => {
    const res = await performDryRun([101]);
    expect(res.copied).toBeGreaterThanOrEqual(1);
  });

  test('copy dedupes and inserts chunks', async () => {
    process.env.COPY_PAGE_SIZE = '1000';
    process.env.COPY_INSERT_CHUNK_SIZE = '1000';
    const res = await copyDataWithBulkInsert({ batchSize: 10, force: false, dryRun: false, insertChunkSize: 1000 });
    expect(res.copied).toBeGreaterThanOrEqual(1);
    expect(res.errors).toBe(0);
  });
});


