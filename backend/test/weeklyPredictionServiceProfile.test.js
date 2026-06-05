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

describe('weeklyPredictionService execution profiles', function() {
  it('uses the default profile for normal requests', function() {
    const harness = loadFresh('src/services/weeklyPredictionService.js', {
      'src/services/stockDataService.js': {},
      'src/services/multiModelAIService.js': { getMultiModelPrediction: async () => null },
      'src/services/fundamentalsService.js': {},
      'src/services/newsSentimentService.js': {},
      'src/services/stockUniverse.js': { ALL_STOCKS: [], TOP_200: [], MEGA_CAP: [], TOTAL_COUNT: 0 },
      'src/services/cacheService.js': { get: () => null, set: () => {} },
      'src/services/weeklyPredictionSnapshotService.js': { loadWeeklyPredictionSnapshot: () => null, saveWeeklyPredictionSnapshot: () => {} }
    });

    try {
      const profile = harness.loaded.resolveWeeklyExecutionProfile({ universe: 'TOP_200' });
      expect(profile).to.deep.equal({ name: 'default', batchSize: 3, batchDelayMs: 2000 });
    } finally {
      harness.restore();
    }
  });

  it('uses the lower-pressure warmup profile for ALL-universe warmups', function() {
    const harness = loadFresh('src/services/weeklyPredictionService.js', {
      'src/services/stockDataService.js': {},
      'src/services/multiModelAIService.js': { getMultiModelPrediction: async () => null },
      'src/services/fundamentalsService.js': {},
      'src/services/newsSentimentService.js': {},
      'src/services/stockUniverse.js': { ALL_STOCKS: [], TOP_200: [], MEGA_CAP: [], TOTAL_COUNT: 0 },
      'src/services/cacheService.js': { get: () => null, set: () => {} },
      'src/services/weeklyPredictionSnapshotService.js': { loadWeeklyPredictionSnapshot: () => null, saveWeeklyPredictionSnapshot: () => {} }
    });

    try {
      const profile = harness.loaded.resolveWeeklyExecutionProfile({ universe: 'ALL', executionProfile: 'warmup' });
      expect(profile).to.deep.equal({ name: 'warmup', batchSize: 1, batchDelayMs: 5000 });
    } finally {
      harness.restore();
    }
  });
});