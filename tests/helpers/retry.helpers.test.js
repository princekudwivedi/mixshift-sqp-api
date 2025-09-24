const { RetryHelpers } = require('../../src/helpers/sqp.helpers');

function makeModel() {
  let retry = 0;
  const logs = [];
  return {
    getRetryCount: async () => retry,
    incrementRetryCount: async () => { retry += 1; },
    logCronActivity: async (row) => { logs.push(row); },
    updateSQPReportStatus: async () => {}
  };
}

describe('RetryHelpers.executeWithRetry', () => {
  test('succeeds without retry', async () => {
    const model = makeModel();
    const res = await RetryHelpers.executeWithRetry({
      cronDetailID: 1,
      amazonSellerID: 'A',
      reportType: 'MONTH',
      action: 'TEST',
      operation: async () => ({ message: 'ok' }),
      model
    });
    expect(res.success).toBe(true);
    expect(res.attempt).toBe(1);
  });

  test('retries on retryable error then succeeds', async () => {
    const model = makeModel();
    let calls = 0;
    const res = await RetryHelpers.executeWithRetry({
      cronDetailID: 2,
      amazonSellerID: 'A',
      reportType: 'MONTH',
      action: 'TEST',
      operation: async () => {
        calls += 1;
        if (calls < 2) throw Object.assign(new Error('timeout'), { status: 500 });
        return { message: 'ok' };
      },
      maxRetries: 3,
      model
    });
    expect(res.success).toBe(true);
    expect(calls).toBe(2);
  });

  test('circuit breaker opens on 429', async () => {
    const model = makeModel();
    const res1 = await RetryHelpers.executeWithRetry({
      cronDetailID: 3,
      amazonSellerID: 'A',
      reportType: 'MONTH',
      action: 'TEST',
      operation: async () => { throw Object.assign(new Error('throttled'), { status: 429 }); },
      maxRetries: 1,
      model
    });
    expect(res1.success).toBe(false);

    const res2 = await RetryHelpers.executeWithRetry({
      cronDetailID: 3,
      amazonSellerID: 'A',
      reportType: 'MONTH',
      action: 'TEST',
      operation: async () => ({ message: 'ok' }),
      maxRetries: 1,
      model
    });
    // Should be skipped due to circuit open
    expect(res2.skipped).toBe(true);
  });
});


