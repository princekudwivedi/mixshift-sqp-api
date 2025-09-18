const sqpCopyService = require('../src/services/sqp.file.processing.service');

// Mock sequelize models used inside the service
jest.mock('../src/models/sequelize/sqpMetrics3mo.model', () => ({
  getModel: () => ({
    findAll: jest.fn(async ({ where }) => {
      // Two physical rows map to one logical record (same ASIN+SearchQuery)
      if (where.ReportID === 111) {
        return [
          { ReportID: 111, ASIN: 'A1', SearchQuery: 'q', ReportDate: '2025-09-01', ID: 1 },
          { ReportID: 111, ASIN: 'A1', SearchQuery: 'q', ReportDate: '2025-09-01', ID: 2 },
        ];
      }
      return [];
    }),
    count: jest.fn(async ({ where }) => {
      if (where.ReportID === 111) return 2;
      return 0;
    })
  })
}));

jest.mock('../src/models/sequelize/sqpMetrics.model', () => ({
  getModel: () => ({
    count: jest.fn(async () => 0),
    bulkCreate: jest.fn(async () => {}),
    sequelize: { transaction: async (cb) => cb({}) },
    rawAttributes: { ReportID: {}, ASIN: {}, SearchQuery: {}, ReportDate: {}, ID: {} },
  })
}));

jest.mock('../src/models/sqp.metrics.model', () => ({
  getReportIdsWithDataIn3mo: jest.fn(async () => [111])
}));

jest.mock('../src/models/sqp.download.urls.model', () => ({
  markDataCopiedToMain: jest.fn(async () => 1)
}));

describe('SQP copy service', () => {
  test('dry run counts distinct logical rows', async () => {
    const result = await sqpCopyService.performDryRun([111]);
    expect(result.copied).toBe(1); // two physical rows collapse to one logical
    expect(result.processed).toBe(1);
  });

  test('copy happy-path inserts deduped records', async () => {
    const out = await sqpCopyService.copyDataWithBulkInsert({ batchSize: 10, force: false, dryRun: false, insertChunkSize: 10 });
    expect(out.processed).toBe(1);
    expect(out.copied).toBe(1);
    expect(out.errors).toBe(0);
  });
});


