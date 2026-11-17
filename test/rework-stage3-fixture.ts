import { overviewFixture } from './fixtures/overview-made-up';

export function leaveCheckWorkedExample() {
  const ws = overviewFixture('2026-11-10');
  const snapshot = ws.swapFinder!.snapshot;
  const dates = ['2026-12-20', '2026-12-21', '2026-12-22', '2026-12-23', '2026-12-24', '2026-12-25', '2026-12-26', '2026-12-27'];
  const [rowan, , hart, moss, vale] = ws.profile.staff;
  // The example has four same-tier doctors; Dr Vale is in FY2 for this fixture.
  vale.groupIds = [ws.profile.groups.find(group => group.name === 'FY2')!.id];
  for (const person of ws.profile.staff) {
    for (const date of dates) snapshot.days[person.id][date] = { status: 'dayJob', activity: 'Float CT', sessions: ['am', 'pm'] };
  }
  snapshot.days[rowan.id] = {
    '2026-12-20': { status: 'longDay', activity: 'Gynae Ward CT', sessions: ['am', 'pm', 'eve'] },
    '2026-12-21': { status: 'zero', activity: 'Zero Day', sessions: ['am'] },
    '2026-12-22': { status: 'dayJob', activity: 'Float CT', sessions: ['am', 'pm'] },
    '2026-12-23': { status: 'dayJob', activity: 'MAU CT', sessions: ['am', 'pm'] },
    '2026-12-24': { status: 'dayJob', activity: 'MAU CT', sessions: ['am', 'pm'] },
    '2026-12-25': { status: 'blank', activity: '' },
    '2026-12-26': { status: 'zero', activity: 'Zero Day', sessions: ['am'] },
    '2026-12-27': { status: 'zero', activity: 'Zero Day', sessions: ['am'] },
  };
  for (const date of dates) snapshot.days[moss.id][date] = { status: 'leave', activity: '[Away]' };
  snapshot.days[hart.id]['2026-12-21'] = { status: 'training', activity: 'Self Development Time' };
  snapshot.days[vale.id]['2026-12-22'] = { status: 'training', activity: 'Training Day CT' };
  ws.swapFinder!.settings.bankHolidays = ['2026-12-25'];
  return { ws, dates };
}
