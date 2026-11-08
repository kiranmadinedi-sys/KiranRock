/** PC resource monitor (2026-11-08). */
jest.mock('../src/config/database', () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }));
jest.mock('../src/utils/logger', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const res = require('../src/services/systemResourceService');

beforeEach(() => res._resetForTests());

const ok = { memTotalGb: 31, memFreeGb: 10, memUsedPct: 68, cpuPct: 30, diskFreeGb: 600, loopP99Ms: 20, dbMs: 5 };

test('cpuPct from cumulative times', () => {
    expect(res.cpuPct(null, { idle: 1, total: 2 })).toBeNull();
    expect(res.cpuPct({ idle: 100, total: 200 }, { idle: 125, total: 300 })).toBeCloseTo(75);
});

test('parseTasklist groups by image and sorts by memory', () => {
    const csv = '"node.exe","1","Console","2","72,124 K"\r\n"node.exe","2","Console","2","1,000 K"\r\n"ollama.exe","3","Console","2","20,000,000 K"\r\n';
    const p = res.parseTasklist(csv);
    expect(p[0]).toEqual({ name: 'ollama', mb: 19531, count: 1 });
    expect(p[1]).toEqual({ name: 'node', mb: 71, count: 2 });
});

test('RAM alert needs 3 low checks in a row, fires once, then clears', () => {
    const low = { ...ok, memFreeGb: 1.2, memUsedPct: 96 };
    expect(res.evaluate(low, 0).fire).toEqual([]);
    expect(res.evaluate(low, 1).fire).toEqual([]);
    expect(res.evaluate(low, 2).fire.map(f => f.key)).toEqual(['mem_low']);
    expect(res.evaluate(low, 3).fire).toEqual([]);           // already active
    expect(res.evaluate(ok, 4).clear).toEqual(['mem_low']);
});

test('a single spike resets the streak', () => {
    const low = { ...ok, memFreeGb: 1 };
    res.evaluate(low, 0); res.evaluate(low, 1); res.evaluate(ok, 2);
    expect(res.evaluate(low, 3).fire).toEqual([]);
});

test('5-minute-only fields are skipped on 1-minute samples, not reset', () => {
    const down = { ...ok, ollamaUp: false };
    res.evaluate(down, 0); res.evaluate(ok, 1); res.evaluate(down, 2);
    expect(res.evaluate(down, 3).fire.map(f => f.key)).toEqual(['ollama_down']);
});

test('failed DB check counts as slow; disk low fires immediately', () => {
    const bad = { ...ok, dbMs: null, diskFreeGb: 20 };
    expect(res.evaluate(bad, 0).fire.map(f => f.key)).toEqual(['disk_low']);
    res.evaluate(bad, 1);
    expect(res.evaluate(bad, 2).fire.map(f => f.key)).toEqual(['db_slow']);
});

test('week line reads plainly', () => {
    const line = res.formatWeekLine({ rows: 2000, mem_avg_pct: 61, mem_peak_pct: 93, mem_free_min_gb: 2.2, cpu_avg: 22, cpu_p95: 88, disk_free_gb: 610,
        db_ms_max: 900, db_fail_rows: 0, loop_max_ms: 300, ollama_down_rows: 0, alert_rows: 0, busiestHour: { hour_ct: 16, mem: 80, cpu: 60 } });
    expect(line).toMatch('peak 93%');
    expect(line).toMatch('busiest hour: 16:00 CT');
    expect(line).not.toMatch('⚠️');
});
