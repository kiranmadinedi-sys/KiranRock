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

describe('healthStatusService.buildHealthResponse', function() {
  it('reports ok when the worker is healthy', function() {
    const { buildHealthResponse } = require('../src/services/healthStatusService');

    const response = buildHealthResponse({
      dbOk: true,
      reportSnapshot: { present: true, fresh: true, ageMs: 1000 },
      workerStatus: { present: true, healthy: true, status: 'running' },
      uptimeSeconds: 12.4,
      timestamp: '2026-04-30T00:00:00.000Z',
      env: { BROKER: 'alpaca', DATA_PROVIDER: 'alpaca', BOT_ENABLED: 'true' }
    });

    expect(response.httpStatus).to.equal(200);
    expect(response.body.status).to.equal('ok');
    expect(response.body.worker.status).to.equal('running');
    expect(response.body.reportSnapshot.fresh).to.equal(true);
    expect(response.body.broker).to.equal('alpaca');
  });

  it('reports degraded when the worker is stale even if the database is up', function() {
    const { buildHealthResponse } = require('../src/services/healthStatusService');

    const response = buildHealthResponse({
      dbOk: true,
      reportSnapshot: { present: false, fresh: false, ageMs: null },
      workerStatus: { present: true, healthy: false, status: 'stale' },
      uptimeSeconds: 5,
      env: { BOT_ENABLED: 'false' }
    });

    expect(response.httpStatus).to.equal(200);
    expect(response.body.status).to.equal('degraded');
    expect(response.body.botEnabled).to.equal(false);
  });

  it('reports degraded and 503 when the database is down', function() {
    const { buildHealthResponse } = require('../src/services/healthStatusService');

    const response = buildHealthResponse({
      dbOk: false,
      reportSnapshot: { present: false, fresh: false, ageMs: null },
      workerStatus: { present: false, healthy: false, status: 'unknown' },
      uptimeSeconds: 1,
      env: {}
    });

    expect(response.httpStatus).to.equal(503);
    expect(response.body.status).to.equal('degraded');
    expect(response.body.db).to.equal('unreachable');
  });
});

describe('workerCoordinationService', function() {
  it('returns missing when no worker row exists', async function() {
    const harness = loadFresh('src/services/workerCoordinationService.js', {
      'src/config/database.js': {
        pool: {},
        query: async () => ({ rowCount: 0, rows: [] })
      }
    });

    try {
      const status = await harness.loaded.getWorkerStatus('primary-worker');
      expect(status.present).to.equal(false);
      expect(status.status).to.equal('missing');
    } finally {
      harness.restore();
    }
  });

  it('returns stale when the heartbeat is older than the threshold', async function() {
    const staleTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const harness = loadFresh('src/services/workerCoordinationService.js', {
      'src/config/database.js': {
        pool: {},
        query: async () => ({
          rowCount: 1,
          rows: [{
            worker_name: 'primary-worker',
            instance_id: 'instance-1',
            role: 'leader',
            status: 'running',
            started_at: new Date().toISOString(),
            heartbeat_at: staleTimestamp,
            metadata: { pid: 1234 }
          }]
        })
      }
    });

    try {
      const status = await harness.loaded.getWorkerStatus('primary-worker');
      expect(status.present).to.equal(true);
      expect(status.healthy).to.equal(false);
      expect(status.status).to.equal('stale');
    } finally {
      harness.restore();
    }
  });

  it('acquires and releases leadership with advisory lock calls', async function() {
    const clientQueries = [];
    let released = false;
    const persistedRows = [];

    const client = {
      async query(sql, params) {
        clientQueries.push({ sql, params });
        if (sql.includes('pg_try_advisory_lock')) {
          return { rows: [{ acquired: true }] };
        }
        if (sql.includes('pg_advisory_unlock')) {
          return { rows: [{ pg_advisory_unlock: true }] };
        }
        throw new Error(`Unexpected client query: ${sql}`);
      },
      release() {
        released = true;
      }
    };

    const harness = loadFresh('src/services/workerCoordinationService.js', {
      'src/config/database.js': {
        pool: {
          connect: async () => client
        },
        query: async (sql, params) => {
          if (sql.includes('CREATE TABLE IF NOT EXISTS worker_runtime_status')) {
            return { rows: [] };
          }
          if (sql.includes('CREATE INDEX IF NOT EXISTS idx_worker_runtime_status_heartbeat')) {
            return { rows: [] };
          }
          if (sql.includes('INSERT INTO worker_runtime_status')) {
            persistedRows.push(params);
            return {
              rows: [{
                worker_name: params[0],
                instance_id: params[1],
                role: params[2],
                status: params[3],
                started_at: new Date().toISOString(),
                heartbeat_at: new Date().toISOString(),
                metadata: JSON.parse(params[4])
              }]
            };
          }
          throw new Error(`Unexpected DB query: ${sql}`);
        }
      }
    });

    try {
      const acquired = await harness.loaded.acquireLeadership({
        workerName: 'primary-worker',
        instanceId: 'instance-1',
        metadata: { pid: 101 }
      });

      expect(acquired.acquired).to.equal(true);
      expect(acquired.workerName).to.equal('primary-worker');
      expect(persistedRows).to.have.lengthOf(1);

      await harness.loaded.updateLeadershipStatus('running', { pid: 101, state: 'steady' });
      expect(persistedRows).to.have.lengthOf(2);

      await harness.loaded.releaseLeadership('stopped', { pid: 101, state: 'done' });
      expect(clientQueries.some(entry => entry.sql.includes('pg_advisory_unlock'))).to.equal(true);
      expect(released).to.equal(true);
    } finally {
      harness.restore();
    }
  });

  it('returns uninitialized when the worker table does not exist yet', async function() {
    const harness = loadFresh('src/services/workerCoordinationService.js', {
      'src/config/database.js': {
        pool: {},
        query: async () => {
          const error = new Error('relation does not exist');
          error.code = '42P01';
          throw error;
        }
      }
    });

    try {
      const status = await harness.loaded.getWorkerStatus('primary-worker');
      expect(status.present).to.equal(false);
      expect(status.status).to.equal('uninitialized');
    } finally {
      harness.restore();
    }
  });
});