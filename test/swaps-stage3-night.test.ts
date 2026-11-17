import { describe, expect, it } from 'vitest';
import { addDays } from '../src/engine/calendar';
import { findSwaps } from '../src/engine/swaps';
import { restDaysAroundBlock, testerRestPackageForLink } from './swaps-night-rest-helpers';
import { blankSnapshot, off, setDay, stage2Profile, stage2Request, stage2Settings, work } from './swaps-stage2-helpers';

describe('night rest package rules (tester-written)', () => {
  const ids = ['fig', 'grove'];
  const profile = stage2Profile(ids, ['Night ward', 'Day clinic']);
  profile.staff.find(s => s.id === 'fig')!.name = 'Dr Fig';
  profile.staff.find(s => s.id === 'grove')!.name = 'Dr Grove';

  function twoNightSwap() {
    const snapshot = blankSnapshot(ids);
    const start = '2026-11-10';
    for (let i = 0; i < 2; i++) {
      work(snapshot, 'fig', addDays(start, i), 'night', 'Night ward');
      work(snapshot, 'grove', addDays('2026-11-24', i), 'night', 'Night ward');
      off(snapshot, 'grove', addDays(start, i));
      off(snapshot, 'fig', addDays('2026-11-24', i));
    }
    return { snapshot, start };
  }

  it('treats the first rest day on each side as mandatory and later days as recommended', () => {
    const { start } = twoNightSwap();
    const settings = stage2Settings({ nightRestDaysBefore: 2, nightRestDaysAfter: 2 });
    const days = restDaysAroundBlock(start, addDays(start, 1), 2, settings);
    expect(days.filter(d => d.tier === 'mandatory').map(d => d.date)).toEqual([addDays(start, -1), addDays(start, 2)]);
    expect(days.filter(d => d.tier === 'recommended').map(d => d.date)).toEqual([addDays(start, -2), addDays(start, 3)]);
  });

  it('uses three recommended days after a block of four or more nights by default', () => {
    const settings = stage2Settings();
    const days = restDaysAroundBlock('2026-11-10', '2026-11-13', 4, settings);
    expect(days.filter(d => d.tier === 'recommended' && d.date > '2026-11-13')).toHaveLength(2);
    expect(days.find(d => d.date === addDays('2026-11-13', 1))?.tier).toBe('mandatory');
    expect(days.find(d => d.date === addDays('2026-11-13', 3))).toBeDefined();
  });

  it('passes day jobs on mandatory rest back to the block owner when they are free', () => {
    const { snapshot, start } = twoNightSwap();
    const mandatoryBefore = addDays(start, -1);
    work(snapshot, 'grove', mandatoryBefore, 'dayJob', 'Day clinic');
    off(snapshot, 'fig', mandatoryBefore);
    const settings = stage2Settings();
    const block: import('../src/engine/swaps').SwapUnit = {
      kind: 'nightBlock', staffId: 'fig', dates: [start, addDays(start, 1)], activity: 'Night ward', dayType: 'weekday', hours: 12.5,
    };
    const offFn = (staffId: string, date: string) => {
      const day = snapshot.days[staffId]?.[date];
      return day?.status === 'zero' || day?.status === 'blank';
    };
    const outcome = testerRestPackageForLink('fig', 'grove', block, [], snapshot, settings, offFn);
    expect(outcome.reject).toBeUndefined();
    expect(outcome.moved).toContainEqual({
      fromStaffId: 'grove', toStaffId: 'fig', date: mandatoryBefore, activity: 'Day clinic', kind: 'dayJob',
    });
    const engine = findSwaps(profile, snapshot, settings, stage2Request('fig', [start]));
    expect(engine.plans[0]?.movedShifts).toContainEqual(outcome.moved[0]);
  });

  it('rejects mandatory rest with training and alerts on recommended rest', () => {
    const mandatory = twoNightSwap();
    const mandatoryBefore = addDays(mandatory.start, -1);
    work(mandatory.snapshot, 'grove', mandatoryBefore, 'dayJob', 'Day clinic');
    work(mandatory.snapshot, 'fig', mandatoryBefore, 'dayJob', 'Day clinic');
    expect(findSwaps(profile, mandatory.snapshot, stage2Settings(), stage2Request('fig', [mandatory.start])).plans).toHaveLength(0);

    const recommended = twoNightSwap();
    const recommendedBefore = addDays(recommended.start, -2);
    work(recommended.snapshot, 'grove', recommendedBefore, 'dayJob', 'Day clinic');
    work(recommended.snapshot, 'fig', recommendedBefore, 'dayJob', 'Day clinic');
    const plan = findSwaps(profile, recommended.snapshot, stage2Settings(), stage2Request('fig', [recommended.start])).plans[0];
    expect(plan).toBeDefined();
    expect(plan.movedShifts).toBeUndefined();
    expect(plan.alerts?.some(a => a.date === recommendedBefore)).toBe(true);
  });

  it('ignores leave and zero days on rest, and alerts for existing nights without rejecting', () => {
    const leaveCase = twoNightSwap();
    const mandatoryAfter = addDays(leaveCase.start, 2);
    leaveCase.snapshot.days.grove[mandatoryAfter] = { status: 'leave', activity: 'Annual leave' };
    expect(findSwaps(profile, leaveCase.snapshot, stage2Settings(), stage2Request('fig', [leaveCase.start])).plans[0]).toBeDefined();

    const nightCase = twoNightSwap();
    work(nightCase.snapshot, 'grove', addDays(nightCase.start, -1), 'night', 'Night ward');
    const alerted = findSwaps(profile, nightCase.snapshot, stage2Settings(), stage2Request('fig', [nightCase.start])).plans[0];
    expect(alerted?.alerts?.some(a => a.message.toLowerCase().includes('existing nights'))).toBe(true);

    const zeroCase = twoNightSwap();
    setDay(zeroCase.snapshot, 'grove', addDays(zeroCase.start, -1), 'zero', 'Zero Day', ['am']);
    expect(findSwaps(profile, zeroCase.snapshot, stage2Settings(), stage2Request('fig', [zeroCase.start])).plans[0]?.movedShifts).toBeUndefined();
  });
});
