import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { addDays, weekday } from '../src/engine/calendar';
import { detectPatterns, type RotaSnapshot, type SnapshotDay } from '../src/engine/swaps';
import { applyImport, planImport } from '../src/app/mediImport';
import { isActivityWeek, isPersonWeek, parsePersonWeek, type PersonWeek } from '../src/app/medirota';
import { emptyWorkspace } from '../src/app/store';
import type { ISODate } from '../src/engine/types';

const ROTA_PAGES_DIR = process.env.ROTA_PAGES_DIR;

function loadPersonWeeks(dir: string): PersonWeek[] {
  const weeks: PersonWeek[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/\.html?$/i.test(name)) continue;
    const html = readFileSync(join(dir, name), 'utf8');
    if (isActivityWeek(html)) continue;
    if (!isPersonWeek(html)) continue;
    weeks.push(parsePersonWeek(html));
  }
  return weeks.sort((a, b) => a.start.localeCompare(b.start));
}

function nightBlocks(snapshot: RotaSnapshot): { total: number; mon4: number; fri3: number } {
  let total = 0;
  let mon4 = 0;
  let fri3 = 0;
  for (const days of Object.values(snapshot.days)) {
    const dates = Object.keys(days).filter(d => days[d].status === 'night').sort();
    let i = 0;
    while (i < dates.length) {
      const block = [dates[i]];
      while (i + 1 < dates.length && addDays(dates[i], 1) === dates[i + 1]) {
        i++;
        block.push(dates[i]);
      }
      total++;
      if (weekday(block[0]) === 0 && block.length === 4) mon4++;
      if (weekday(block[0]) === 4 && block.length === 3) fri3++;
      i++;
    }
  }
  return { total, mon4, fri3 };
}

const CHANGEOVER = new Set<ISODate>([
  '2026-08-03', '2026-08-04', '2026-08-05', '2026-08-06', '2026-08-07',
  '2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03', '2026-12-04',
]);
const BANK = new Set<ISODate>(['2026-08-31', '2026-12-25', '2026-12-28', '2027-01-01']);

function physicallyWorkingInDay(day: SnapshotDay | undefined): boolean {
  if (!day) return false;
  if (day.status === 'dayJob' || day.status === 'longDay') return true;
  if (day.status === 'partShift' && day.sessions?.some(s => s === 'am' || s === 'pm')) return true;
  return false;
}

function workingDoctors(snapshot: RotaSnapshot, date: ISODate): number {
  let n = 0;
  for (const days of Object.values(snapshot.days)) {
    if (physicallyWorkingInDay(days[date])) n++;
  }
  return n;
}

function weekdaysBelowMin(snapshot: RotaSnapshot): number {
  const dates = new Set<ISODate>();
  for (const days of Object.values(snapshot.days)) for (const d of Object.keys(days)) dates.add(d);
  let below = 0;
  for (const date of [...dates].sort()) {
    const wd = weekday(date);
    if (wd === 5 || wd === 6) continue;
    if (BANK.has(date) || CHANGEOVER.has(date)) continue;
    if (workingDoctors(snapshot, date) < 7) below++;
  }
  return below;
}

/** Max Zero Day weeks on Mon–Fri only (weekend zeros ignored). */
function maxZeroWeeksMonFri(snapshot: RotaSnapshot, staffId: string, weeks: ISODate[]): number {
  let max = 0;
  for (let target = 0; target < 5; target++) {
    const zeros = weeks.filter(start => snapshot.days[staffId]?.[addDays(start, target)]?.status === 'zero').length;
    if (zeros > max) max = zeros;
  }
  return max;
}

function staffWithMonFriZerosAbove9(
  snapshot: RotaSnapshot,
  weeks: ISODate[],
  excludeStaffIds: Set<string>,
): number {
  return Object.keys(snapshot.days)
    .filter(id => !excludeStaffIds.has(id))
    .filter(id => maxZeroWeeksMonFri(snapshot, id, weeks) > 9)
    .length;
}

describe.skipIf(!ROTA_PAGES_DIR)('swap finder real-data check (ROTA_PAGES_DIR)', () => {
  it('prints counts only and matches section 9 expectations', () => {
    const weeks = loadPersonWeeks(ROTA_PAGES_DIR!);
    expect(weeks.length).toBeGreaterThan(0);

    const ws = emptyWorkspace();
    applyImport(ws, planImport(ws, weeks, []));
    const snapshot = ws.swapFinder!.snapshot;
    const importedWeeks = Object.keys(snapshot.importedAt).sort();

    const flags = detectPatterns(snapshot);
    const regular = flags.filter(f => f.kind === 'regularDaysOff');
    const oneDay = flags.filter(f => f.kind === 'oneWeekday');
    const blocks = nightBlocks(snapshot);
    const below = weekdaysBelowMin(snapshot);

    const regularWedThu26 = regular.filter(f => f.weekdays.includes(2) && f.weekdays.includes(3) && f.weeksInPost === 26);
    const regularOffStaff = new Set(regular.map(f => f.staffId));
    const othersAbove9 = staffWithMonFriZerosAbove9(snapshot, importedWeeks, regularOffStaff);

    // Counts only in output (no names).
    console.log(JSON.stringify({
      personWeekFiles: weeks.length,
      importedWeekStarts: importedWeeks.length,
      regularDaysOffFlags: regular.length,
      regularWedThu26: regularWedThu26.length,
      staffWithMonFriZeroWeeksAbove9: othersAbove9,
      oneWeekdayFlags: oneDay.length,
      oneWeekdayTuesday: oneDay.filter(f => f.weekdays[0] === 1).length,
      oneWeekdayWednesday: oneDay.filter(f => f.weekdays[0] === 2).length,
      nightBlocksTotal: blocks.total,
      nightBlocksMon4: blocks.mon4,
      nightBlocksFri3: blocks.fri3,
      weekdaysBelowMin7: below,
    }));

    expect(regularWedThu26.length).toBe(1);
    expect(regular.length).toBe(1);
    expect(othersAbove9).toBe(0);
    expect(oneDay.length).toBe(2);
    expect(oneDay.filter(f => f.weekdays[0] === 1).length).toBe(1);
    expect(oneDay.filter(f => f.weekdays[0] === 2).length).toBe(1);
    expect(blocks.total).toBe(105);
    expect(blocks.mon4).toBe(40);
    expect(blocks.fri3).toBe(40);
    expect(below).toBe(3);
  });
});
