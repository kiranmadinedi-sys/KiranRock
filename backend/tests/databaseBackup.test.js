/** Database backup rotation (2026-10-26). */
const { filesToPrune } = require('../src/services/databaseBackupService');

test('keeps the newest N daily and N weekly backups, deletes older ones', () => {
    const names = [
        'kiranrock_2026-10-20_daily.dump', 'kiranrock_2026-10-21_daily.dump', 'kiranrock_2026-10-22_daily.dump',
        'kiranrock_2026-10-23_daily.dump', 'kiranrock_2026-10-24_daily.dump',
        'kiranrock_2026-10-04_weekly.dump', 'kiranrock_2026-10-11_weekly.dump', 'kiranrock_2026-10-18_weekly.dump',
    ];
    expect(filesToPrune(names, { daily: 3, weekly: 2 }).sort()).toEqual([
        'kiranrock_2026-10-04_weekly.dump', 'kiranrock_2026-10-20_daily.dump', 'kiranrock_2026-10-21_daily.dump',
    ]);
});

test('nothing to delete while under the limits', () => {
    expect(filesToPrune(['kiranrock_2026-10-26_daily.dump'], { daily: 7, weekly: 4 })).toEqual([]);
});
