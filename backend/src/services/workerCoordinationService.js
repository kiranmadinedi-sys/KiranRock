const { pool, query } = require('../config/database');

const DEFAULT_WORKER_NAME = process.env.WORKER_NAME || 'primary-worker';
const HEARTBEAT_INTERVAL_MS = parseInt(process.env.WORKER_HEARTBEAT_INTERVAL_MS || '30000', 10);
const STALE_THRESHOLD_MS = parseInt(process.env.WORKER_STALE_THRESHOLD_MS || '90000', 10);

let leadershipClient = null;
let leadershipState = null;
let heartbeatTimer = null;

async function ensureWorkerStatusSchema() {
    await query(`
        CREATE TABLE IF NOT EXISTS worker_runtime_status (
            worker_name VARCHAR(100) PRIMARY KEY,
            instance_id VARCHAR(150) NOT NULL,
            role VARCHAR(30) NOT NULL DEFAULT 'leader',
            status VARCHAR(30) NOT NULL DEFAULT 'starting',
            started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            heartbeat_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            metadata JSONB DEFAULT '{}'::jsonb
        )
    `);

    await query(`
        CREATE INDEX IF NOT EXISTS idx_worker_runtime_status_heartbeat
        ON worker_runtime_status(heartbeat_at)
    `);
}

async function persistWorkerStatus(status = leadershipState?.status, metadata = leadershipState?.metadata) {
    if (!leadershipState) {
        return null;
    }

    leadershipState.status = status || leadershipState.status;
    leadershipState.metadata = metadata || leadershipState.metadata || {};

    const result = await query(`
        INSERT INTO worker_runtime_status (
            worker_name,
            instance_id,
            role,
            status,
            started_at,
            heartbeat_at,
            metadata
        ) VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $5::jsonb)
        ON CONFLICT (worker_name) DO UPDATE SET
            instance_id = EXCLUDED.instance_id,
            role = EXCLUDED.role,
            status = EXCLUDED.status,
            started_at = CASE
                WHEN worker_runtime_status.instance_id = EXCLUDED.instance_id
                    THEN worker_runtime_status.started_at
                ELSE CURRENT_TIMESTAMP
            END,
            heartbeat_at = CURRENT_TIMESTAMP,
            metadata = EXCLUDED.metadata
        RETURNING worker_name, instance_id, role, status, started_at, heartbeat_at, metadata
    `, [
        leadershipState.workerName,
        leadershipState.instanceId,
        leadershipState.role,
        leadershipState.status,
        JSON.stringify(leadershipState.metadata || {})
    ]);

    return result.rows[0];
}

function startHeartbeatLoop() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
    }

    heartbeatTimer = setInterval(() => {
        persistWorkerStatus().catch((error) => {
            console.error('[Worker Coordination] Heartbeat update failed:', error.message);
        });
    }, HEARTBEAT_INTERVAL_MS);

    if (typeof heartbeatTimer.unref === 'function') {
        heartbeatTimer.unref();
    }
}

async function acquireLeadership(options = {}) {
    if (leadershipClient && leadershipState) {
        return { acquired: true, ...leadershipState };
    }

    const workerName = options.workerName || DEFAULT_WORKER_NAME;
    const instanceId = options.instanceId;
    const role = options.role || 'leader';
    const metadata = options.metadata || {};

    if (!instanceId) {
        throw new Error('instanceId is required to acquire worker leadership');
    }

    await ensureWorkerStatusSchema();

    const client = await pool.connect();

    try {
        const lockResult = await client.query(
            'SELECT pg_try_advisory_lock(hashtext($1)) AS acquired',
            [workerName]
        );

        if (!lockResult.rows[0]?.acquired) {
            client.release();
            return { acquired: false, workerName };
        }

        leadershipClient = client;
        leadershipState = {
            workerName,
            instanceId,
            role,
            status: 'starting',
            metadata
        };

        await persistWorkerStatus('starting', metadata);
        startHeartbeatLoop();

        return { acquired: true, ...leadershipState };
    } catch (error) {
        client.release();
        throw error;
    }
}

async function updateLeadershipStatus(status, metadata) {
    if (!leadershipState) {
        return null;
    }

    return persistWorkerStatus(status, metadata || leadershipState.metadata);
}

async function releaseLeadership(status = 'stopped', metadata) {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    if (leadershipState) {
        try {
            await persistWorkerStatus(status, metadata || leadershipState.metadata);
        } catch (error) {
            console.error('[Worker Coordination] Failed to persist shutdown status:', error.message);
        }
    }

    if (leadershipClient && leadershipState) {
        try {
            await leadershipClient.query(
                'SELECT pg_advisory_unlock(hashtext($1))',
                [leadershipState.workerName]
            );
        } catch (error) {
            console.error('[Worker Coordination] Failed to release advisory lock:', error.message);
        }

        leadershipClient.release();
    }

    leadershipClient = null;
    leadershipState = null;
}

async function getWorkerStatus(workerName = DEFAULT_WORKER_NAME) {
    try {
        const result = await query(`
            SELECT worker_name, instance_id, role, status, started_at, heartbeat_at, metadata
            FROM worker_runtime_status
            WHERE worker_name = $1
        `, [workerName]);

        if (result.rowCount === 0) {
            return {
                workerName,
                present: false,
                healthy: false,
                status: 'missing'
            };
        }

        const row = result.rows[0];
        const heartbeatAt = new Date(row.heartbeat_at);
        const heartbeatAgeMs = Date.now() - heartbeatAt.getTime();
        const healthy = heartbeatAgeMs <= STALE_THRESHOLD_MS && row.status !== 'stopped';

        return {
            workerName: row.worker_name,
            present: true,
            healthy,
            status: healthy ? row.status : 'stale',
            role: row.role,
            instanceId: row.instance_id,
            startedAt: row.started_at,
            heartbeatAt: row.heartbeat_at,
            heartbeatAgeSeconds: Math.max(0, Math.round(heartbeatAgeMs / 1000)),
            metadata: row.metadata || {}
        };
    } catch (error) {
        if (error.code === '42P01') {
            return {
                workerName,
                present: false,
                healthy: false,
                status: 'uninitialized'
            };
        }

        throw error;
    }
}

module.exports = {
    acquireLeadership,
    ensureWorkerStatusSchema,
    getWorkerStatus,
    releaseLeadership,
    updateLeadershipStatus
};