const fs = require('fs');
const os = require('os');
const path = require('path');
const { expect } = require('chai');

describe('weeklyPredictionSnapshotService', function() {
  const originalDir = process.env.WEEKLY_PREDICTION_SNAPSHOT_DIR;
  let snapshotDir;

  beforeEach(function() {
    snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weekly-snapshot-'));
    process.env.WEEKLY_PREDICTION_SNAPSHOT_DIR = snapshotDir;
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

  it('persists and reloads a weekly prediction snapshot', function() {
    const service = require('../src/services/weeklyPredictionSnapshotService');
    const payload = { topPicks: [{ symbol: 'AAPL' }], totalAnalyzed: 820 };

    service.saveWeeklyPredictionSnapshot('weekly_predictions:ALL:60:25:all:0:0', payload);
    const snapshot = service.loadWeeklyPredictionSnapshot('weekly_predictions:ALL:60:25:all:0:0', 60 * 1000);

    expect(snapshot).to.not.equal(null);
    expect(snapshot.payload).to.deep.equal(payload);
    expect(snapshot.ageMs).to.be.at.least(0);
  });
});