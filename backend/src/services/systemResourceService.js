/**
 * System resource monitor (2026-11-08) — watches the PC the whole app runs on.
 *
 * Every minute: RAM, CPU, C: free space, worker event-loop lag, DB round-trip.
 * Every 5 minutes one row goes into system_resource_samples (avg/max of those minutes
 * plus memory by process group, DB connections, Ollama models loaded) — the history
 * used to tune num_ctx, scan concurrency and schedules, and to answer "was the PC
 * the reason?" after an incident (RAM-driven DB timeouts 10-29, sleep outage 09-14).
 *
 * Alerts go to the admin only when a breach persists (N consecutive checks), at most
 * once an hour per problem, with an all-clear when it recovers. Thresholds are env
 * overridable. Report only — never kills or restarts anything (one exception: it asks Ollama
 * to unload an idle model whose server has bloated, see ollamaService.recycleIfBloated). Never throws.
 */
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { monitorEventLoopDelay } = require('perf_hooks');
const { query } = require('../config/database');
const { logger } = require('../utils/logger');

const SAMPLE_MS = 60 * 1000;
const FLUSH_EVERY = 5;               // samples per stored row
const RETAIN_DAYS = 180;
const ALERT_COOLDOWN_MS = 60 * 60 * 1000;
const num = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== '' ? Number(process.env[k]) : d);

// Each rule: breached(sample) + how many consecutive checks before alerting.
const RULES = {
    mem_low:   { n: 3,  test: s => s.memFreeGb != null && s.memFreeGb < num('RES_MEM_FREE_GB_MIN', 2),
                 text: s => `RAM almost full — ${s.memFreeGb.toFixed(1)} GB free of ${s.memTotalGb.toFixed(0)} GB (${s.memUsedPct.toFixed(0)}% used). DB timeouts and slow scans follow this.` },
    cpu_high:  { n: 15, test: s => s.cpuPct != null && s.cpuPct > num('RES_CPU_PCT_MAX', 95),
                 text: s => `CPU pinned — ${s.cpuPct.toFixed(0)}% for 15+ minutes.` },
    disk_low:  { n: 1,  test: s => s.diskFreeGb != null && s.diskFreeGb < num('RES_DISK_FREE_GB_MIN', 50),
                 text: s => `Disk C: low — ${s.diskFreeGb.toFixed(0)} GB free (logs, DB, backups need room).` },
    db_slow:   { n: 3,  test: s => s.dbMs == null || s.dbMs > num('RES_DB_MS_MAX', 3000),
                 text: s => (s.dbMs == null ? 'Database not answering a simple query for 3+ minutes.' : `Database slow — a simple query took ${Math.round(s.dbMs)} ms for 3+ minutes.`) },
    loop_lag:  { n: 3,  test: s => s.loopP99Ms != null && s.loopP99Ms > num('RES_LOOP_MS_MAX', 5000),
                 text: s => `Worker blocked — event loop stalled up to ${Math.round(s.loopP99Ms)} ms for 3+ minutes (timers and stop checks run late).` },
    db_conns:  { n: 2,  only: 'dbConns', test: s => s.dbConns != null && s.dbConnsMax && s.dbConns / s.dbConnsMax > 0.85,
                 text: s => `Database connections near the limit — ${s.dbConns}/${s.dbConnsMax}.` },
    ollama_down: { n: 3, only: 'ollamaUp', test: s => s.ollamaUp === false,
                 text: () => 'Ollama not answering on 127.0.0.1:11434 (15+ minutes) — local AI calls will fail. After a reboot it needs a sign-in.' },
};

let _timer = null;
let _loop = null;
let _prevCpu = null;
let _buf = [];
let _tick = 0;
const _streak = {};     // rule → consecutive breaches
const _active = {};     // rule → true while alerted and not recovered
const _lastAlert = {};  // rule → ms

let _ready = false;
async function ensureTable() {
    if (_ready) return;
    await query(`
        CREATE TABLE IF NOT EXISTS system_resource_samples (
            ts                TIMESTAMPTZ PRIMARY KEY,
            mem_total_gb      REAL,
            mem_used_pct_avg  REAL,
            mem_used_pct_max  REAL,
            mem_free_gb_min   REAL,
            cpu_pct_avg       REAL,
            cpu_pct_max       REAL,
            disk_free_gb      REAL,
            loop_p99_ms_max   REAL,
            db_ms_max         REAL,
            db_conns          INT,
            db_conns_max      INT,
            db_size_gb        REAL,
            ollama_up         BOOLEAN,
            procs             JSONB,
            ollama            JSONB,
            alerts            TEXT[]
        )`);
    _ready = true;
}

function _cpuTimes() {
    let idle = 0, total = 0;
    for (const c of os.cpus()) { for (const v of Object.values(c.times)) total += v; idle += c.times.idle; }
    return { idle, total };
}

/** CPU % since the previous call (os.loadavg is always 0 on Windows). */
function cpuPct(prev, cur) {
    if (!prev) return null;
    const dt = cur.total - prev.total;
    return dt > 0 ? Math.max(0, Math.min(100, (1 - (cur.idle - prev.idle) / dt) * 100)) : null;
}

function _diskFreeGb() {
    try {
        const s = fs.statfsSync(process.env.RES_DISK_PATH || (process.platform === 'win32' ? 'C:/' : '/'));
        return (s.bavail * s.bsize) / 2 ** 30;
    } catch { return null; }
}

async function _dbMs() {
    const t = Date.now();
    try { await query('SELECT 1'); return Date.now() - t; } catch { return null; }
}

/** Working-set MB by image name from tasklist CSV, largest first. */
function parseTasklist(csv) {
    const groups = {};
    for (const line of String(csv).split(/\r?\n/)) {
        const m = line.match(/^"([^"]+)","\d+","[^"]*","\d+","([\d,.\s]+)\s*K"/);
        if (!m) continue;
        const name = m[1].toLowerCase().replace(/\.exe$/, '');
        const kb = Number(m[2].replace(/[^\d]/g, ''));
        const g = groups[name] || (groups[name] = { mb: 0, count: 0 });
        g.mb += kb / 1024; g.count++;
    }
    return Object.entries(groups).map(([name, g]) => ({ name, mb: Math.round(g.mb), count: g.count })).sort((a, b) => b.mb - a.mb);
}

function _procs() {
    if (process.platform !== 'win32') return Promise.resolve(null);
    return new Promise(resolve => {
        execFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 15000, windowsHide: true, maxBuffer: 4 * 2 ** 20 }, (err, out) => {
            if (err) return resolve(null);
            const all = parseTasklist(out);
            // Keep the app's own processes plus whatever else is big.
            const app = /^(node|postgres|ollama|ollama app|vmmemwsl|vmmem|cloudflared|redis-server|chrome|code)$/;
            resolve(all.filter((p, i) => app.test(p.name) || i < 8));
        });
    });
}

async function _ollama() {
    const base = (process.env.OLLAMA_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(/\/$/, '');
    try {
        const ctl = AbortSignal.timeout(5000);
        const r = await fetch(`${base}/api/ps`, { signal: ctl });
        if (!r.ok) return { up: false };
        const j = await r.json();
        return { up: true, models: (j.models || []).map(m => ({ name: m.name, gb: +((m.size || 0) / 2 ** 30).toFixed(1), vramGb: +((m.size_vram || 0) / 2 ** 30).toFixed(1) })) };
    } catch { return { up: false }; }
}

async function _dbStats() {
    try {
        const r = await query(`SELECT (SELECT count(*) FROM pg_stat_activity)::int AS conns,
                                      current_setting('max_connections')::int AS max,
                                      pg_database_size(current_database())::float / 1073741824 AS size_gb`);
        return r.rows[0];
    } catch { return null; }
}

/** Decide which alerts / all-clears to send for this sample. Pure apart from state. */
function evaluate(sample, now = Date.now()) {
    const fire = [], clear = [];
    for (const [key, rule] of Object.entries(RULES)) {
        if (rule.only && sample[rule.only] === undefined) continue; // 5-minute-only field, not in this sample
        if (rule.test(sample)) {
            _streak[key] = (_streak[key] || 0) + 1;
            if (_streak[key] >= rule.n && !_active[key] && (_lastAlert[key] == null || now - _lastAlert[key] >= ALERT_COOLDOWN_MS)) {
                _active[key] = true; _lastAlert[key] = now;
                fire.push({ key, text: rule.text(sample) });
            }
        } else {
            _streak[key] = 0;
            if (_active[key]) { _active[key] = false; clear.push(key); }
        }
    }
    return { fire, clear };
}

const CLEAR_TEXT = {
    mem_low: 'RAM back to normal', cpu_high: 'CPU back to normal', disk_low: 'Disk space back above the limit',
    db_slow: 'Database responding normally', loop_lag: 'Worker event loop normal', db_conns: 'DB connections back to normal',
    ollama_down: 'Ollama answering again',
};

async function _notify(fire, clear, sample) {
    if (!fire.length && !clear.length) return;
    const top = (sample.procs || []).slice(0, 5).map(p => `${p.name} ${(p.mb / 1024).toFixed(1)} GB`).join(', ');
    const L = [];
    if (fire.length) {
        L.push('🖥️ <b>PC resource alert</b>');
        for (const f of fire) L.push(`• ${f.text}`);
        if (top) L.push(`Biggest processes: ${top}`);
        if (sample.ollamaModels && sample.ollamaModels.length) L.push(`Ollama loaded: ${sample.ollamaModels.map(m => `${m.name} ${m.gb} GB`).join(', ')}`);
        L.push('Report only — nothing was restarted.');
    }
    if (clear.length) L.push(`✅ ${clear.map(k => CLEAR_TEXT[k] || k).join('; ')}.`);
    await require('./telegramAlertService').sendAdminMessage(L.join('\n'), 'HTML').catch(() => {});
}

async function sampleOnce() {
    const cur = _cpuTimes();
    const s = {
        memTotalGb: os.totalmem() / 2 ** 30,
        memFreeGb: os.freemem() / 2 ** 30,     // Windows: available physical memory
        cpuPct: cpuPct(_prevCpu, cur),
        diskFreeGb: _diskFreeGb(),
        loopP99Ms: _loop ? _loop.percentile(99) / 1e6 : null,
        dbMs: await _dbMs(),
    };
    s.memUsedPct = (1 - s.memFreeGb / s.memTotalGb) * 100;
    _prevCpu = cur;
    if (_loop) _loop.reset();
    return s;
}

const _avg = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const _max = a => (a.length ? Math.max(...a) : null);
const _min = a => (a.length ? Math.min(...a) : null);
const _vals = (rows, k) => rows.map(r => r[k]).filter(v => v != null);

async function _tickOnce() {
    try {
        const s = await sampleOnce();
        _tick++;
        const flush = _tick % FLUSH_EVERY === 0;
        if (flush) {
            const [procs, ol, db] = await Promise.all([_procs(), _ollama(), _dbStats()]);
            s.procs = procs; s.ollamaUp = ol.up; s.ollamaModels = ol.models || [];
            if (db) { s.dbConns = db.conns; s.dbConnsMax = db.max; s.dbSizeGb = db.size_gb; }
            // The one exception to "report only": ask Ollama to unload an idle, bloated model
            // (llama-server grew ~0.9 GB/h on 2026-11-09). It reloads on the next call.
            const llama = (procs || []).find(p => p.name === 'llama-server');
            if (llama) await require('./ollamaService').recycleIfBloated(llama.mb, s.ollamaModels).catch(() => {});
        }
        _buf.push(s);
        const { fire, clear } = evaluate(s);
        await _notify(fire, clear, s);
        if (flush) {
            const b = _buf; _buf = [];
            await ensureTable();
            await query(
                `INSERT INTO system_resource_samples (ts, mem_total_gb, mem_used_pct_avg, mem_used_pct_max, mem_free_gb_min, cpu_pct_avg, cpu_pct_max,
                    disk_free_gb, loop_p99_ms_max, db_ms_max, db_conns, db_conns_max, db_size_gb, ollama_up, procs, ollama, alerts)
                 VALUES (date_trunc('minute', NOW()), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT (ts) DO NOTHING`,
                [s.memTotalGb, _avg(_vals(b, 'memUsedPct')), _max(_vals(b, 'memUsedPct')), _min(_vals(b, 'memFreeGb')),
                 _avg(_vals(b, 'cpuPct')), _max(_vals(b, 'cpuPct')), s.diskFreeGb, _max(_vals(b, 'loopP99Ms')),
                 b.some(x => x.dbMs == null) ? null : _max(_vals(b, 'dbMs')),
                 s.dbConns ?? null, s.dbConnsMax ?? null, s.dbSizeGb ?? null, s.ollamaUp ?? null,
                 s.procs ? JSON.stringify(s.procs) : null, JSON.stringify(s.ollamaModels || []),
                 Object.keys(_active).filter(k => _active[k])]);
            if (_tick % (FLUSH_EVERY * 288) === 0) { // about once a day
                await query(`DELETE FROM system_resource_samples WHERE ts < NOW() - ($1 || ' days')::interval`, [String(RETAIN_DAYS)]);
            }
        }
    } catch (err) {
        logger.warn('[Resources] Sample failed', { error: err.message });
    }
}

function start() {
    if (_timer) return;
    try { _loop = monitorEventLoopDelay({ resolution: 50 }); _loop.enable(); } catch { _loop = null; }
    _prevCpu = _cpuTimes();
    _timer = setInterval(_tickOnce, SAMPLE_MS);
    if (_timer.unref) _timer.unref();
    logger.info('[Resources] Monitor started (1-min samples, 5-min rows)');
}

function stop() {
    if (_timer) clearInterval(_timer);
    _timer = null;
    if (_loop) { _loop.disable(); _loop = null; }
}

/** Last 7 days in plain numbers, for the Friday report and tuning. */
async function weekSummary() {
    await ensureTable();
    const r = (await query(`
        SELECT count(*)::int AS rows,
               max(mem_used_pct_max)::float AS mem_peak_pct, min(mem_free_gb_min)::float AS mem_free_min_gb,
               avg(mem_used_pct_avg)::float AS mem_avg_pct,
               avg(cpu_pct_avg)::float AS cpu_avg, percentile_cont(0.95) WITHIN GROUP (ORDER BY cpu_pct_max)::float AS cpu_p95,
               min(disk_free_gb)::float AS disk_free_gb, max(db_ms_max)::float AS db_ms_max,
               count(*) FILTER (WHERE db_ms_max IS NULL)::int AS db_fail_rows,
               max(loop_p99_ms_max)::float AS loop_max_ms,
               count(*) FILTER (WHERE ollama_up = false)::int AS ollama_down_rows,
               count(*) FILTER (WHERE cardinality(alerts) > 0)::int AS alert_rows
        FROM system_resource_samples WHERE ts > NOW() - INTERVAL '7 days'`)).rows[0];
    if (!r || !r.rows) return null;
    const peak = (await query(`
        SELECT extract(hour FROM ts AT TIME ZONE 'America/Chicago')::int AS hour_ct, avg(mem_used_pct_avg)::float AS mem, avg(cpu_pct_avg)::float AS cpu
        FROM system_resource_samples WHERE ts > NOW() - INTERVAL '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 1`)).rows[0] || null;
    return { ...r, busiestHour: peak };
}

function formatWeekLine(w) {
    if (!w) return null;
    const f = v => (v == null ? 'n/a' : v.toFixed(0));
    const L = [`  RAM: avg ${f(w.mem_avg_pct)}% used, peak ${f(w.mem_peak_pct)}% (lowest free ${w.mem_free_min_gb == null ? 'n/a' : w.mem_free_min_gb.toFixed(1) + ' GB'})`,
        `  CPU: avg ${f(w.cpu_avg)}%, busy minutes (95th pct) ${f(w.cpu_p95)}% · disk C: ${f(w.disk_free_gb)} GB free`,
        `  DB slowest ${f(w.db_ms_max)} ms${w.db_fail_rows ? ` (${w.db_fail_rows} windows with failed checks)` : ''} · worker stall max ${f(w.loop_max_ms)} ms`];
    if (w.busiestHour) L.push(`  busiest hour: ${w.busiestHour.hour_ct}:00 CT (RAM ${f(w.busiestHour.mem)}%, CPU ${f(w.busiestHour.cpu)}%)`);
    if (w.ollama_down_rows || w.alert_rows) L.push(`  ⚠️ ${w.alert_rows} five-minute windows with an alert${w.ollama_down_rows ? `, Ollama down ${w.ollama_down_rows * 5} min` : ''}`);
    return L.join('\n');
}

function _resetForTests() { for (const o of [_streak, _active, _lastAlert]) for (const k of Object.keys(o)) delete o[k]; }

module.exports = { start, stop, sampleOnce, evaluate, cpuPct, parseTasklist, weekSummary, formatWeekLine, ensureTable, RULES, _resetForTests, _tickOnce };
