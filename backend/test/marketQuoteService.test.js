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

describe('marketQuoteService', function() {
  it('extracts regularMarketPrice from yfClient quotes', async function() {
    const harness = loadFresh('src/services/marketQuoteService.js', {
      'src/utils/yfClient.js': {
        quote: async () => ({ regularMarketPrice: 123.45 })
      }
    });

    try {
      const price = await harness.loaded.getCurrentPrice('AAPL');
      expect(price).to.equal(123.45);
    } finally {
      harness.restore();
    }
  });

  it('falls back to nested price objects when needed', async function() {
    const harness = loadFresh('src/services/marketQuoteService.js', {
      'src/utils/yfClient.js': {
        quote: async () => ({ price: { regularMarketPrice: 99.5 } })
      }
    });

    try {
      const price = await harness.loaded.getCurrentPrice('MSFT');
      expect(price).to.equal(99.5);
    } finally {
      harness.restore();
    }
  });
});

describe('tradingService.getCurrentPrice', function() {
  it('delegates quote lookup to marketQuoteService', async function() {
    const harness = loadFresh('src/services/tradingService.js', {
      'src/config/database.js': {
        query: async () => ({ rows: [] })
      },
      'src/services/marketQuoteService.js': {
        getCurrentPrice: async () => 77.25
      }
    });

    try {
      const price = await harness.loaded.getCurrentPrice('NVDA');
      expect(price).to.equal(77.25);
    } finally {
      harness.restore();
    }
  });
});