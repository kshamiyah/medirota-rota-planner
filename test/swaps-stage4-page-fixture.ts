/**
 * Made-up rota with more than 50 direct swaps and more than 10 three-way chains
 * for one leave date, so the page can exercise "Find 50 more".
 */
import { addDays } from '../src/engine/calendar';
import type { ISODate } from '../src/engine/types';
import type { Workspace } from '../src/app/store';
import { blankSnapshot, off, stage2Profile, stage2Settings, work } from './swaps-stage2-helpers';

export const STAGE4_PAGE_LEAVE = '2026-11-09';

export function buildStage4PagingWorkspace(): { workspace: Workspace; leaveDate: ISODate } {
  const directs = Array.from({ length: 55 }, (_, index) => `direct-${index}`);
  const middles = Array.from({ length: 55 }, (_, index) => `middle-${index}`);
  const ends = Array.from({ length: 55 }, (_, index) => `end-${index}`);
  const ids = ['requester', ...directs, ...middles, ...ends];
  const profile = stage2Profile(ids, ['Night ward']);
  profile.staff.find(person => person.id === 'requester')!.name = 'Dr Rowan';
  for (const [index, id] of directs.entries()) profile.staff.find(person => person.id === id)!.name = `Dr Direct ${index + 1}`;
  for (const [index, id] of middles.entries()) profile.staff.find(person => person.id === id)!.name = `Dr Middle ${index + 1}`;
  for (const [index, id] of ends.entries()) profile.staff.find(person => person.id === id)!.name = `Dr End ${index + 1}`;

  const snapshot = blankSnapshot(ids, 70);
  work(snapshot, 'requester', STAGE4_PAGE_LEAVE, 'night', 'Night ward');
  work(snapshot, 'requester', addDays(STAGE4_PAGE_LEAVE, 1), 'night', 'Night ward');
  directs.forEach((id, index) => {
    const ret = addDays('2026-11-16', index * 7);
    off(snapshot, id, STAGE4_PAGE_LEAVE);
    off(snapshot, id, addDays(STAGE4_PAGE_LEAVE, 1));
    work(snapshot, id, ret, 'night', 'Night ward');
    work(snapshot, id, addDays(ret, 1), 'night', 'Night ward');
    off(snapshot, 'requester', ret);
    off(snapshot, 'requester', addDays(ret, 1));
  });
  middles.forEach((id, index) => {
    const middleShift = addDays('2026-11-17', index * 7);
    const endShift = addDays('2026-11-19', index * 7);
    off(snapshot, id, STAGE4_PAGE_LEAVE);
    off(snapshot, id, addDays(STAGE4_PAGE_LEAVE, 1));
    work(snapshot, id, middleShift, 'night', 'Night ward');
    work(snapshot, id, addDays(middleShift, 1), 'night', 'Night ward');
    work(snapshot, ends[index], STAGE4_PAGE_LEAVE, 'night', 'Night ward');
    work(snapshot, ends[index], addDays(STAGE4_PAGE_LEAVE, 1), 'night', 'Night ward');
    off(snapshot, ends[index], middleShift);
    off(snapshot, ends[index], addDays(middleShift, 1));
    work(snapshot, ends[index], endShift, 'night', 'Night ward');
    work(snapshot, ends[index], addDays(endShift, 1), 'night', 'Night ward');
    off(snapshot, 'requester', endShift);
    off(snapshot, 'requester', addDays(endShift, 1));
  });

  const workspace: Workspace = {
    version: 1,
    profile,
    staffExtras: {},
    period: { start: '2026-11-09', end: '2026-11-15' },
    unavailability: [],
    fixed: [],
    rota: { assignments: [], stages: [], seconds: 1, createdAt: '2026-11-04T12:00:00.000Z' },
    swapFinder: { settings: stage2Settings({ maxChain: 3 }), snapshot },
  };
  return { workspace, leaveDate: STAGE4_PAGE_LEAVE };
}
