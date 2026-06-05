const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

describe('weeklyPredictionSnapshotService status helpers', function() {
  const originalDir = process.env.WEEKLY_PREDICTION_SNAPSHOT_DIR;
  let snapshotDir;

  beforeEach(function() {
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-snapshot-status-'));
    process.env.WEEKLY_PREDICTION_SNAPSHOT_DIR = snapshotDir;
    delete require.cache[require.resolve('../src/services/weeklyPredictionSnapshotService')];
  });

  afterEach(function() {
    if (originalDir === undefined) {
      delete process.env.WEEKLY_PREDICTION_SNAPSHOT_DIR;
    } else {
      process.env.WEEKLY_PREDICTION_SNAPSHOT_DIR = originalDir;
    }

    delete require.cache[require.resolve('../src/services/weeklyPredictionSnapshotService')];
    fs.rmSync(snapshotDir, { recursive: true, force: true });
  });

  it('reports missing snapshots as not present and not fresh', function() {
    const service = require('../src/services/weeklyPredictionSnapshotService');
    const status = service.getWeeklyPredictionSnapshotStatus('weekly_predictions:ALL:60:25:all:0:0', 60000);

    expect(status.present).to.equal(false);
    expect(status.fresh).to.equal(false);
    expect(status.maxAgeMs).to.equal(60000);
  });

  it('reports stored snapshots as present and fresh within the allowed age', function() {
    const service = require('../src/services/weeklyPredictionSnapshotService');
    const cacheKey = 'weekly_predictions:ALL:60:25:all:0:0';

    service.saveWeeklyPredictionSnapshot(cacheKey, { topPicks: [{ symbol: 'AAPL' }] });
    const status = service.getWeeklyPredictionSnapshotStatus(cacheKey, 60000);

    expect(status.present).to.equal(true);
    expect(status.fresh).to.equal(true);
    expect(status.createdAt).to.be.a('string');
    expect(status.ageMs).to.be.at.least(0);
  });
});