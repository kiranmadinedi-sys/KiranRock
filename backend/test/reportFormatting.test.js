const path = require('path');
const { expect } = require('chai');

function resolveFromBackend(moduleId) {
  const backendRoot = path.join(__dirname, '..');

  if (moduleId.startsWith('src/') || moduleId.startsWith('test/')) {
    return require.resolve(path.join(backendRoot, moduleId));
  }

  return require.resolve(moduleId, { paths: [backendRoot] });
}

function loadFresh(moduleId, mocks = {}) {
  const resolvedModule = resolveFromBackend(moduleId);
  const touched = [];
  const originals = new Map();

  delete require.cache[resolvedModule];

  for (const [mockId, mockExports] of Object.entries(mocks)) {
    const resolvedMock = resolveFromBackend(mockId);
    originals.set(resolvedMock, require.cache[resolvedMock]);
    require.cache[resolvedMock] = {
      id: resolvedMock,
      filename: resolvedMock,
      loaded: true,
      exports: mockExports
    };
    touched.push(resolvedMock);
  }

  const loaded = require(resolvedModule);

  return {
    loaded,
    restore() {
      delete require.cache[resolvedModule];
      for (const resolvedMock of touched) {
        const original = originals.get(resolvedMock);
        if (original) {
          require.cache[resolvedMock] = original;
        } else {
          delete require.cache[resolvedMock];
        }
      }
    }
  };
}

describe('sendWeeklyReportToTelegram helpers', function() {
  it('builds a deduplicated request plan with ALL first by default', function() {
    const harness = loadFresh('src/sendWeeklyReportToTelegram.js', {
      'src/services/telegramService.js': {
        sendTelegramMessage: async () => {},
        getPrimaryTelegramRecipient: async () => null
      },
      axios: {},
      'src/services/weeklyPredictionSnapshotService.js': {
        loadWeeklyPredictionSnapshot: () => null
      },
      'src/services/weeklyPredictionService.js': {
        buildWeeklyPredictionCacheKey: () => 'weekly_predictions:ALL:60:25:all:0:0',
        WEEKLY_CACHE_TTL: 30 * 60 * 1000
      }
    });

    try {
      expect(harness.loaded.buildPredictionRequestPlan()).to.deep.equal(['ALL', 'TOP_200', 'MEGA_CAP']);
    } finally {
      harness.restore();
    }
  });

  it('summarizes ranked-universe breadth for visibility sections', function() {
    const harness = loadFresh('src/sendWeeklyReportToTelegram.js', {
      'src/services/telegramService.js': {
        sendTelegramMessage: async () => {},
        getPrimaryTelegramRecipient: async () => null
      },
      axios: {},
      'src/services/weeklyPredictionSnapshotService.js': {
        loadWeeklyPredictionSnapshot: () => null
      },
      'src/services/weeklyPredictionService.js': {
        buildWeeklyPredictionCacheKey: () => 'weekly_predictions:ALL:60:25:all:0:0',
        WEEKLY_CACHE_TTL: 30 * 60 * 1000
      }
    });

    try {
      const summary = harness.loaded.summarizeRankedUniverse([
        {
          totalScore: 82,
          sector: 'Technology',
          prediction: { signal: 'Buy', confidence: 88, expectedMove: '6.5' },
          riskAnalysis: { riskScore: 35 }
        },
        {
          totalScore: 74,
          sector: 'Technology',
          prediction: { signal: 'Buy', confidence: 81, expectedMove: '5.0' },
          riskAnalysis: { riskScore: 55 }
        },
        {
          totalScore: 63,
          sector: 'Healthcare',
          prediction: { signal: 'Hold', confidence: 64, expectedMove: '1.5' },
          riskAnalysis: { riskScore: 68 }
        }
      ]);

      expect(summary.count).to.equal(3);
      expect(summary.avgScore).to.equal(73);
      expect(summary.avgConfidence).to.equal(78);
      expect(summary.signals).to.deep.equal({ Buy: 2, Hold: 1 });
      expect(summary.sectors[0]).to.deep.equal({ sector: 'Technology', count: 2 });
      expect(summary.riskBuckets).to.deep.equal({ low: 1, medium: 1, high: 1 });
      expect(summary.strongSetups).to.equal(2);
    } finally {
      harness.restore();
    }
  });

  it('builds report prediction options for the primary universe', function() {
    const harness = loadFresh('src/sendWeeklyReportToTelegram.js', {
      'src/services/telegramService.js': {
        sendTelegramMessage: async () => {},
        getPrimaryTelegramRecipient: async () => null
      },
      axios: {},
      'src/services/weeklyPredictionSnapshotService.js': {
        loadWeeklyPredictionSnapshot: () => null
      },
      'src/services/weeklyPredictionService.js': {
        buildWeeklyPredictionCacheKey: () => 'weekly_predictions:ALL:60:25:all:0:0',
        WEEKLY_CACHE_TTL: 30 * 60 * 1000
      }
    });

    try {
      expect(harness.loaded.buildReportPredictionOptions()).to.deep.equal({
        limit: 25,
        minScore: 60,
        universe: 'ALL'
      });
    } finally {
      harness.restore();
    }
  });
});