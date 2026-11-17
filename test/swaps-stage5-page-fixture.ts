/** Made-up department for the Stage 5 page check. No real rota data. */
import { addDays } from '../src/engine/calendar';
import type { Workspace } from '../src/app/store';
import { blankSnapshot, off, stage2Profile, stage2Settings, work } from './swaps-stage2-helpers';

const LONG = 'Labour ward';
const NIGHT = 'Night ward';

export function buildStage5PageWorkspace(): Workspace {
  const ids = ['rowan', 'ellis', 'hart', 'moss', 'vale'];
  const profile = stage2Profile(ids, [LONG, NIGHT, 'Clinic'], [
    { id: 'hours', name: 'Hours', type: 'maxHours', hard: true, hours: 72, windowDays: 7 },
  ]);
  const names: Record<string, string> = {
    rowan: 'Dr Rowan', ellis: 'Dr Ellis', hart: 'Dr Hart', moss: 'Dr Moss', vale: 'Dr Vale',
  };
  for (const person of profile.staff) person.name = names[person.id];
  const snapshot = blankSnapshot(ids, 8);
  work(snapshot, 'rowan', '2026-11-10', 'longDay', LONG);
  work(snapshot, 'rowan', '2026-11-11', 'dayJob', 'Clinic');
  work(snapshot, 'rowan', '2026-11-12', 'longDay', LONG);
  work(snapshot, 'rowan', '2026-11-16', 'night', NIGHT);
  work(snapshot, 'rowan', '2026-11-17', 'night', NIGHT);
  off(snapshot, 'rowan', '2026-11-18');
  for (const date of ['2026-12-04', '2026-12-05', '2026-12-06']) {
    work(snapshot, 'rowan', date, 'longDay', LONG);
    off(snapshot, 'ellis', date);
  }
  for (const date of ['2026-12-07', '2026-12-08', '2026-12-09', '2026-12-10', '2026-12-11']) work(snapshot, 'ellis', date, 'longDay', LONG);
  for (const date of ['2026-12-18', '2026-12-19', '2026-12-20']) {
    work(snapshot, 'ellis', date, 'longDay', LONG);
    off(snapshot, 'rowan', date);
  }
  work(snapshot, 'hart', '2026-11-18', 'night', NIGHT);
  off(snapshot, 'hart', '2026-12-04');
  work(snapshot, 'hart', '2026-12-15', 'longDay', LONG);
  off(snapshot, 'rowan', '2026-12-15');
  for (const date of ['2026-11-10', '2026-12-04']) {
    off(snapshot, 'moss', date);
    off(snapshot, 'vale', date);
  }

  return {
    version: 1,
    profile,
    staffExtras: {},
    period: { start: '2026-11-02', end: addDays('2026-11-02', 55) },
    unavailability: [{ staffId: 'vale', date: '2026-11-20', kind: 'leave', reason: 'Made-up leave' }],
    fixed: [{ staffId: 'moss', date: '2026-11-20', shiftTypeId: 'day', reason: 'Made-up clinic' }],
    rota: { assignments: [{ staffId: 'hart', date: '2026-11-19', shiftTypeId: 'day' }], stages: [], seconds: 1, createdAt: '2026-11-04T12:00:00.000Z' },
    swapFinder: { settings: stage2Settings({ maxChain: 4 }), snapshot },
  };
}
