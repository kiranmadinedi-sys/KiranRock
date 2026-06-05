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

describe('worker process lifecycle', function() {
  it('marks stopping and stopped during shutdown and only exits once', async function() {
    const calls = {
      updateStatus: [],
      release: [],
      stops: [],
      exits: [],
      poolEnds: 0
    };

    const harness = loadFresh('src/worker.js', {
      'src/bootstrapRuntime.js': {},
      'src/services/enhancedAIScheduler.js': {
        startScheduler() {},
        stopScheduler() { calls.stops.push('enhanced-ai'); }
      },
      'src/services/optionsScheduler.js': {
        startOptionsScheduler() {},
        stopOptionsScheduler() { calls.stops.push('options'); }
      },
      'src/services/optionsBotScheduler.js': {
        startOptionsScheduler() {},
        stopOptionsScheduler() { calls.stops.push('options-bot'); }
      },
      'src/services/newsMonitoringService.js': {
        startNewsMonitoring() {},
        stopNewsMonitoring() { calls.stops.push('news'); }
      },
      'src/services/workerCoordinationService.js': {
        acquireLeadership: async () => ({ acquired: true }),
        updateLeadershipStatus: async (status, metadata) => {
          calls.updateStatus.push({ status, metadata });
        },
        releaseLeadership: async (status, metadata) => {
          calls.release.push({ status, metadata });
        }
      },
      'src/config/database.js': {
        pool: {
          async end() {
            calls.poolEnds += 1;
          }
        }
      }
    });

    try {
      harness.loaded.resetWorkerStateForTests();

      const first = await harness.loaded.shutdownWorker('SIGTERM', {
        exit(code) {
          calls.exits.push(code);
        }
      });

      const second = await harness.loaded.shutdownWorker('SIGTERM', {
        exit(code) {
          calls.exits.push(code);
        }
      });

      expect(first.skipped).to.equal(false);
      expect(second).to.deep.equal({ skipped: true, reason: 'already-shutting-down' });
      expect(calls.updateStatus).to.have.lengthOf(1);
      expect(calls.updateStatus[0].status).to.equal('stopping');
      expect(calls.release).to.have.lengthOf(1);
      expect(calls.release[0].status).to.equal('stopped');
      expect(calls.stops).to.have.members(['enhanced-ai', 'options', 'options-bot', 'news']);
      expect(calls.poolEnds).to.equal(1);
      expect(calls.exits).to.deep.equal([0]);
    } finally {
      harness.restore();
    }
  });

  it('exits a secondary worker without starting services when leadership is unavailable', async function() {
    const calls = {
      exits: [],
      starts: [],
      poolEnds: 0,
      telegramLoads: 0
    };

    const harness = loadFresh('src/worker.js', {
      'src/bootstrapRuntime.js': {},
      'src/services/enhancedAIScheduler.js': {
        startScheduler() { calls.starts.push('enhanced-ai'); },
        stopScheduler() {}
      },
      'src/services/optionsScheduler.js': {
        startOptionsScheduler() { calls.starts.push('options'); },
        stopOptionsScheduler() {}
      },
      'src/services/optionsBotScheduler.js': {
        startOptionsScheduler() { calls.starts.push('options-bot'); },
        stopOptionsScheduler() {}
      },
      'src/services/newsMonitoringService.js': {
        startNewsMonitoring() { calls.starts.push('news'); },
        stopNewsMonitoring() {}
      },
      'src/services/workerCoordinationService.js': {
        acquireLeadership: async () => ({ acquired: false, workerName: 'primary-worker' }),
        updateLeadershipStatus: async () => {},
        releaseLeadership: async () => {}
      },
      'src/config/database.js': {
        pool: {
          async end() {
            calls.poolEnds += 1;
          }
        }
      }
    });

    try {
      harness.loaded.resetWorkerStateForTests();

      const result = await harness.loaded.startWorker({
        exit(code) {
          calls.exits.push(code);
        },
        loadTelegramSchedules() {
          calls.telegramLoads += 1;
        }
      });

      expect(result).to.deep.equal({ started: false, reason: 'leadership-not-acquired' });
      expect(calls.exits).to.deep.equal([0]);
      expect(calls.poolEnds).to.equal(1);
      expect(calls.starts).to.deep.equal([]);
      expect(calls.telegramLoads).to.equal(0);
    } finally {
      harness.restore();
    }
  });
});