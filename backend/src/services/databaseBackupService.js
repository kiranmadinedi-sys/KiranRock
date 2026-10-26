/**
 * Nightly database backup (2026-10-26). The 2.2 GB database (trade history, 3y prices, ~1M news,
 * insider data, decision logs, reports) lived only on this PC's disk — GitHub holds code, not data.
 *
 *   - pg_dump custom format (-Fc), verified with pg_restore --list (must list table data)
 *   - local copies in BACKUP_LOCAL_DIR: 7 daily + 4 weekly (Sunday)
 *   - cloud copies in BACKUP_CLOUD_DIR (OneDrive, synced automatically): 4 daily + 4 weekly
 *   - runs 7:00 AM ET daily, after the overnight scan (waits up to 2h while a scan is running)
 *   - Telegram on any failure; a short weekly "backups OK" note on Sundays
 * Restore: pg_restore -h localhost -U postgres -d <new_db> --clean --if-exists <file>.dump
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { logger } = require('../utils/logger');

const PG_BIN = process.env.PG_BIN_DIR || 'C:\\MyProject\\MyDB\\bin';
const LOCAL_DIR = process.env.BACKUP_LOCAL_DIR || 'C:\\MyProject\\Backups\\kiranrock';
const CLOUD_DIR = process.env.BACKUP_CLOUD_DIR || (process.env.OneDrive ? path.join(process.env.OneDrive, 'KiranRock-Backups') : null);
const KEEP = { local: { daily: 7, weekly: 4 }, cloud: { daily: 4, weekly: 4 } };
const MIN_TABLES = 50; // a dump listing fewer table-data entries than this is treated as broken

const run = (file, args, env) => new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 },
        (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).toString().slice(0, 500))) : resolve(stdout)));
});

/** Pure: which backup files to delete, given names like kiranrock_2026-10-26_daily.dump. */
function filesToPrune(names, keep) {
    const del = [];
    for (const kind of ['daily', 'weekly']) {
        const mine = names.filter(n => n.endsWith(`_${kind}.dump`)).sort().reverse();
        del.push(...mine.slice(keep[kind]));
    }
    return del;
}

function _prune(dir, keep) {
    const names = fs.readdirSync(dir).filter(n => /^kiranrock_\d{4}-\d{2}-\d{2}_(daily|weekly)\.dump$/.test(n));
    for (const n of filesToPrune(names, keep)) fs.unlinkSync(path.join(dir, n));
}

async function runBackup(now = new Date()) {
    const day = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const weekly = new Date(`${day}T12:00:00Z`).getUTCDay() === 0;
    const name = `kiranrock_${day}_${weekly ? 'weekly' : 'daily'}.dump`;
    const started = Date.now();
    try {
        fs.mkdirSync(LOCAL_DIR, { recursive: true });
        const tmp = path.join(LOCAL_DIR, `${name}.partial`);
        const final = path.join(LOCAL_DIR, name);
        await run(path.join(PG_BIN, 'pg_dump.exe'), [
            '-h', process.env.DB_HOST || 'localhost', '-p', String(process.env.DB_PORT || 5432),
            '-U', process.env.DB_USER || 'postgres', '-d', process.env.DB_NAME || 'kiranrock_trading',
            '-Fc', '-Z', '6', '-f', tmp,
        ], { PGPASSWORD: process.env.DB_PASSWORD || '' });
        const list = await run(path.join(PG_BIN, 'pg_restore.exe'), ['--list', tmp]);
        const tables = (list.match(/TABLE DATA/g) || []).length;
        if (tables < MIN_TABLES) throw new Error(`backup looks incomplete: only ${tables} tables`);
        fs.renameSync(tmp, final);
        _prune(LOCAL_DIR, KEEP.local);
        const sizeMb = Math.round(fs.statSync(final).size / 1048576);
        let cloud = 'no cloud folder configured';
        if (CLOUD_DIR) {
            fs.mkdirSync(CLOUD_DIR, { recursive: true });
            fs.copyFileSync(final, path.join(CLOUD_DIR, name));
            _prune(CLOUD_DIR, KEEP.cloud);
            cloud = CLOUD_DIR;
        }
        const secs = Math.round((Date.now() - started) / 1000);
        logger.info('[Backup] Database backup OK', { file: name, sizeMb, tables, secs, cloud });
        if (weekly) {
            await require('./telegramAlertService').sendAdminMessage(
                `💾 Weekly backup OK — ${name} (${sizeMb} MB, ${tables} tables). Copies: this PC + OneDrive.`).catch(() => {});
        }
        return { ok: true, name, sizeMb, tables, secs, cloud };
    } catch (err) {
        logger.error('[Backup] Database backup FAILED', { error: err.message });
        await require('./telegramAlertService').sendAdminMessage(
            `⚠️ *Database backup failed* (${day}): ${err.message}\nYesterday's backup is still in place. Ask Claude to look at it.`).catch(() => {});
        return { ok: false, error: err.message };
    }
}

/** Cron entry: wait (up to 2h) for an overnight scan still running, then back up. */
async function runScheduledBackup() {
    const scan = require('./nightlyUniverseScanService');
    for (let i = 0; i < 24 && scan.isScanRunning && scan.isScanRunning(); i++) {
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
    }
    return runBackup();
}

module.exports = { runBackup, runScheduledBackup, filesToPrune, LOCAL_DIR, CLOUD_DIR };
