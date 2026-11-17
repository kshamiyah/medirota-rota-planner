import { describe, expect, it, vi } from 'vitest';
import type { SwapPlan, SwapUnit } from '../src/engine/swaps';
import { DEFAULT_SHARE_LIMIT, makeShareContent, renderSharePng, shareMoreLine, shareText, type ShareInput } from '../src/app/swapShare';

const unit = (staffId: string, dates: string[], kind: SwapUnit['kind'], activity: string): SwapUnit => ({ staffId, dates, kind, activity, dayType: 'weekday', hours: kind === 'nightBlock' ? 12 : 12.5 });
const plan = (ids: string[], dates: string[], kind: SwapUnit['kind'] = 'longDay', warnings: SwapPlan['warnings'] = [], alerts: SwapPlan['alerts'] = []): SwapPlan => ({
  chains: [{ links: ids.map(staffId => ({ staffId, gives: unit(staffId, dates, kind, kind === 'nightBlock' ? 'Nights CT' : 'Long day') })), payDifferent: false }],
  people: ids.length - 1, shiftsMoved: 1, cleared: [], remaining: [], warnings, alerts,
});
const blockPlan = (ids: string[]): SwapPlan => ({
  chains: [['2027-04-11'], ['2027-04-10']].map(dates => ({ links: ids.map(staffId => ({ staffId, gives: unit(staffId, dates, 'longDay', 'Long day') })), payDifferent: false })),
  people: ids.length - 1, shiftsMoved: 2, cleared: [], remaining: [], warnings: [], alerts: [], blockLength: 2,
});
const names: Record<string, string> = { rowan: 'Dr Rowan', ellis: 'Dr Ellis', hart: 'Dr Hart', moss: 'Dr Moss', vale: 'Dr Vale', quinn: 'Dr Quinn', ash: 'Dr Ashworth-Pemberton' };
const input = (plans: SwapPlan[], changes: Partial<ShareInput> = {}): ShareInput => ({ plans, filter: 'all', requesterId: 'rowan', requesterName: 'Dr Rowan', nameFor: id => names[id], covered: [{ dates: ['2026-04-08'], activity: 'Delivery Suite', kind: 'longDay' }], existingShortages: [], importedAt: '2026-11-06T12:00:00Z', limit: 5, ...changes });

describe('swap result sharing', () => {
  it('includes extra shifts handed back to medical staffing', () => {
    const text = shareText(makeShareContent(input([], { extraShiftsToHandBack: [{ date: '2026-04-09', activity: 'MAU CT' }] })));
    expect(text).toContain('• Extra shift on Thu 9 Apr (MAU CT): hand back to medical staffing');
  });
  it('shows direct and three-way options as one row with plain steps and WhatsApp formatting', () => {
    const plans = [plan(['rowan', 'ellis'], ['2026-04-13']), plan(['rowan', 'ellis', 'hart'], ['2026-04-08'])];
    const content = makeShareContent(input(plans)); const text = shareText(content);
    expect(content.sections.map(section => section.title)).toEqual(['Ask one person', 'Ask two people']);
    expect(content.sections[0].rows[0]).toMatchObject({ number: 1, ask: ['Dr Ellis'], instead: 'Mon 13 Apr (Long day)' });
    expect(text).toContain('*Swap options for Dr Rowan*');
    expect(text).toContain('Long day on *Wed 8 Apr* (Delivery Suite)');
    expect(text).toContain('*1. Dr Ellis*\nYou work: Mon 13 Apr (Long day)');
    expect(text).toContain('*2. Dr Ellis + Dr Hart*');
    expect(text).toContain("Dr Hart works Dr Ellis's Wed 8 Apr");
    expect(text).toContain("You work Dr Hart's Wed 8 Apr");
    expect(text).not.toContain('✅ No issues');
    expect(text).not.toMatch(/\b(chain|block)\b/i);
    // One blank line before later section headings, not two.
    expect(text).toContain('You work: Mon 13 Apr (Long day)\n\n*Ask two people*\n');
    expect(text).not.toContain('\n\n\n*Ask two people*');
  });

  it('omits the doctor name on one-person training and NWD notes, and keeps it on 2+ person rows', () => {
    const trainingOne: SwapPlan = { ...plan(['rowan', 'hart'], ['2026-04-08']), missedTraining: [{ staffId: 'hart', date: '2026-04-08' }] };
    const trainingTwo: SwapPlan = {
      ...plan(['rowan', 'ellis', 'hart'], ['2026-04-08']),
      missedTraining: [{ staffId: 'ellis', date: '2026-04-08' }, { staffId: 'hart', date: '2026-04-14' }],
    };
    const nwdOne: SwapPlan = {
      chains: [{
        links: [
          { staffId: 'rowan', gives: unit('rowan', ['2026-04-07'], 'longDay', 'Long day') },
          { staffId: 'moss', gives: unit('moss', ['2026-04-07'], 'dayShift', 'MAU CT') },
        ],
        payDifferent: true,
        sameDay: { doctors: 7, minimum: 7 },
      }],
      people: 1, shiftsMoved: 1, cleared: [], remaining: [], warnings: [],
      leaveRequests: [{ date: '2026-04-07', activity: 'MAU CT' }],
    };
    const mixedOne: SwapPlan = {
      chains: [
        {
          links: [
            { staffId: 'rowan', gives: unit('rowan', ['2026-04-07'], 'longDay', 'Long day') },
            { staffId: 'vale', gives: unit('vale', ['2026-04-07'], 'dayShift', 'MAU CT') },
          ],
          payDifferent: true,
          sameDay: { doctors: 7, minimum: 7 },
        },
        {
          links: [
            { staffId: 'rowan', gives: unit('rowan', ['2026-04-08'], 'longDay', 'Long day') },
            { staffId: 'vale', gives: unit('vale', ['2026-04-14'], 'longDay', 'Long day') },
          ],
          payDifferent: false,
        },
      ],
      people: 1, shiftsMoved: 2, cleared: [], remaining: [], warnings: [],
      leaveRequests: [{ date: '2026-04-07', activity: 'MAU CT' }],
    };
    const training = makeShareContent(input([trainingOne], { limit: 'all' }));
    const nwd = makeShareContent(input([nwdOne], { limit: 'all' }));
    const mixed = makeShareContent(input([mixedOne], { limit: 'all' }));
    const two = makeShareContent(input([trainingTwo], { limit: 'all' }));
    expect(training.sections[0].rows[0].notes).toContain('Misses training on Wed 8 Apr');
    expect(training.sections[0].rows[0].notes.some(note => note.includes('Dr Hart'))).toBe(false);
    expect(shareText(training)).toContain('Misses training on Wed 8 Apr');
    expect(shareText(training)).not.toContain('Dr Hart: Misses training');
    expect(nwd.sections[0].rows[0].sameDay).toBe('NWD swap, you take their MAU CT and request it as annual leave');
    expect(nwd.sections[0].rows[0].notes.some(note => note.includes('Dr Moss'))).toBe(false);
    expect(shareText(nwd)).toContain('1. *Dr Moss*: NWD swap, you take their MAU CT and request it as annual leave');
    expect(shareText(nwd)).not.toContain('Dr Moss works your long day');
    expect(mixed.sections[0].rows[0].notes).toContain('Tue 7 Apr: NWD swap, you take their MAU CT and request it as annual leave');
    expect(mixed.sections[0].rows[0].notes.some(note => note.includes('Dr Vale'))).toBe(false);
    expect(two.sections[0].rows[0].notes).toEqual([
      'Dr Ellis: Misses training on Wed 8 Apr',
      'Dr Hart: Misses training on Tue 14 Apr',
    ]);
    expect(shareText(two)).toContain('Dr Ellis: Misses training on Wed 8 Apr');
    expect(shareText(two)).toContain('Dr Hart: Misses training on Tue 14 Apr');
  });

  it('groups same-person options into Or dates and numbers rows straight through', () => {
    const warning = [{ date: '2026-04-08', doctors: 6, minimum: 7 }];
    const options = [
      plan(['rowan', 'ellis'], ['2026-04-13']),
      plan(['rowan', 'ellis'], ['2026-04-22']),
      { ...plan(['rowan', 'ellis'], ['2026-04-26']), warnings: warning },
      plan(['rowan', 'hart'], ['2026-04-14']),
      plan(['rowan', 'moss'], ['2026-04-15']),
      plan(['rowan', 'vale'], ['2026-04-16']),
      plan(['rowan', 'quinn'], ['2026-04-17']),
      plan(['rowan', 'ellis', 'hart'], ['2026-04-18']),
      plan(['rowan', 'moss', 'vale'], ['2026-04-19']),
    ];
    const content = makeShareContent(input(options)); const text = shareText(content);
    expect(content.sections[0].rows).toHaveLength(5);
    expect(content.sections[0].rows.map(row => row.number)).toEqual([1, 2, 3, 4, 5]);
    expect(content.sections[0].rows[0].alternatives).toEqual([
      { dates: 'Wed 22 Apr (Long day)', sortDate: '2026-04-22', needsCheck: false },
      { dates: 'Sun 26 Apr (Long day)', sortDate: '2026-04-26', needsCheck: true, checkLabel: '6 of 7 doctors' },
    ]);
    expect(text).toContain('Other dates:\n• Wed 22 Apr (Long day)\n• Sun 26 Apr (Long day) ⚠ 6 of 7 doctors');
    expect(content.more).toBe(2);
    expect(text).toContain('2 more options. Ask me for more.');
  });

  it('combines engine-style per-day block chains, sorts return dates, and tags the block', () => {
    const block = blockPlan(['rowan', 'ellis']);
    const content = makeShareContent(input([block])); const text = shareText(content);
    const row = content.sections[0].rows[0];
    expect(row.instead).toBe('Sat 10 + Sun 11 Apr 2027 (Long days)');
    expect(row.keptTogether).toBe(true);
    expect(text).toContain('You work: Sat 10 + Sun 11 Apr 2027 (Long days, kept together)');
  });

  it('uses night and mixed leave headings, night wording, status reasons, and merged shift tags', () => {
    const warning = [{ date: '2026-04-08', doctors: 6, minimum: 7 }];
    const nightPlan = plan(['rowan', 'vale'], ['2026-04-12', '2026-04-13', '2026-04-14', '2026-04-15'], 'nightBlock');
    const nights = makeShareContent(input([nightPlan], { covered: [{ dates: ['2026-04-12', '2026-04-13'], activity: 'Nights CT', kind: 'nightBlock' }, { dates: ['2026-04-14', '2026-04-15'], activity: 'Nights CT', kind: 'nightBlock' }] }));
    expect(nights.subheading).toBe('Dr Rowan');
    expect(nights.shiftTag).toBe('Nights on Sun 12 to Wed 15 Apr (Nights CT)');
    expect(shareText(nights)).toContain('Nights on *Sun 12 to Wed 15 Apr* (Nights CT)');
    expect(nights.sections[0].rows[0].keptTogether).toBe(false);

    const checked = makeShareContent(input([{ ...plan(['rowan', 'moss'], ['2026-04-08']), warnings: warning }]));
    expect(shareText(checked)).toContain('⚠️ Leaves 6 of 7 doctors');
    expect(checked.sections[0].rows[0].reason).toBe('Leaves 6 of 7 doctors');
    const weekendPlan = plan(['rowan', 'moss'], ['2026-04-08']);
    weekendPlan.chains[0].payDifferent = true;
    weekendPlan.chains[0].links[1].gives.dayType = 'weekend';
    expect(shareText(makeShareContent(input([weekendPlan])))).toContain('⚠️ Weekend for a weekday');
    const bankHolidayPlan = plan(['rowan', 'moss'], ['2026-12-28']);
    bankHolidayPlan.chains[0].payDifferent = true;
    bankHolidayPlan.chains[0].links[0].gives.dayType = 'weekday';
    bankHolidayPlan.chains[0].links[1].gives = { ...bankHolidayPlan.chains[0].links[1].gives, dayType: 'bankHoliday', activity: 'Long day' };
    expect(shareText(makeShareContent(input([bankHolidayPlan])))).toContain('⚠️ Bank holiday for a weekday');
    expect(shareText(makeShareContent(input([bankHolidayPlan])))).not.toContain('Weekend for a weekday');
    const mixed = makeShareContent(input([plan(['rowan', 'ellis'], ['2026-04-08'])], { covered: [
      { dates: ['2026-04-08'], activity: 'Delivery Suite', kind: 'longDay' },
      { dates: ['2026-04-09'], activity: 'Nights CT', kind: 'nightBlock' },
    ] }));
    expect(mixed.shiftType).toBe('Leave');
    expect(shareText(mixed)).toContain('Leave on *Wed 8 + Thu 9 Apr*');
  });

  it('shares compact date ranges without dropping a month across boundaries', () => {
    const jan = makeShareContent(input([plan(['rowan', 'ellis'], ['2027-01-30', '2027-01-31'])], {
      covered: [{ dates: ['2027-01-30', '2027-01-31'], activity: 'Long days', kind: 'longDay' }],
    }));
    expect(jan.shiftTag).toBe('Long days on Sat 30 + Sun 31 Jan (Long days)');
    expect(jan.sections[0].rows[0].instead).toBe('Sat 30 + Sun 31 Jan (Long days)');
    expect(shareText(jan)).toContain('Sat 30 + Sun 31 Jan');

    const threeDays = makeShareContent(input([plan(['rowan', 'ellis'], ['2026-12-04', '2026-12-05', '2026-12-06'])], {
      covered: [{ dates: ['2026-12-04', '2026-12-05', '2026-12-06'], activity: 'Long days', kind: 'longDay' }],
    }));
    expect(threeDays.shiftTag).toBe('Long days on Fri 4 to Sun 6 Dec (Long days)');
    const acrossMonths = makeShareContent(input([plan(['rowan', 'ellis'], ['2026-12-31', '2027-01-01'])], {
      covered: [{ dates: ['2026-12-31', '2027-01-01'], activity: 'Long days', kind: 'longDay' }],
    }));
    expect(acrossMonths.shiftTag).toBe('Long days on Thu 31 Dec + Fri 1 Jan 2027 (Long days)');
    expect(shareText(acrossMonths)).toContain('Long days on *Thu 31 Dec + Fri 1 Jan 2027*');
  });

  it('uses compact same-month dates with the shift on each Other dates line', () => {
    const plans = [plan(['rowan', 'ellis'], ['2027-04-08']), plan(['rowan', 'ellis'], ['2027-04-10', '2027-04-11'])];
    const content = makeShareContent(input(plans, { limit: 'all' }));
    expect(shareText(content)).toContain('Other dates:\n• Sat 10 + Sun 11 Apr 2027 (Long days)');
  });

  it('shows night blocks and named long-day places on Other dates lines', () => {
    const nights = plan(['rowan', 'vale'], ['2026-04-12', '2026-04-13', '2026-04-14', '2026-04-15'], 'nightBlock');
    nights.chains[0].links[1].gives.activity = '';
    const named = plan(['rowan', 'ellis'], ['2026-02-21', '2026-02-22']);
    named.chains[0].links[1].gives.activity = 'Delivery Suite';
    const first = plan(['rowan', 'ellis'], ['2026-02-09']);
    first.chains[0].links[1].gives.activity = 'Gynae Ward CT';
    const jun = plan(['rowan', 'ellis'], ['2026-06-15']);
    jun.chains[0].links[1].gives.activity = 'Gynae Ward CT';
    jun.warnings = [{ date: '2026-06-15', doctors: 6, minimum: 7 }];
    const content = makeShareContent(input([first, named, nights, jun], { limit: 'all' }));
    const ellisRow = content.sections[0].rows.find(row => row.ask[0] === 'Dr Ellis')!;
    expect(ellisRow.alternatives.map(item => `${item.dates}${item.checkLabel ? ` ⚠ ${item.checkLabel}` : ''}`)).toEqual([
      'Sat 21 + Sun 22 Feb (Long days, Delivery Suite)',
      'Mon 15 Jun (Gynae Ward CT) ⚠ 6 of 7 doctors',
    ]);
    expect(shareText(content)).toContain('Other dates:\n• Sat 21 + Sun 22 Feb (Long days, Delivery Suite)\n• Mon 15 Jun (Gynae Ward CT) ⚠ 6 of 7 doctors');
    const nightRow = content.sections[0].rows.find(row => row.ask[0] === 'Dr Vale')!;
    expect(nightRow.instead).toBe('Sun 12 to Wed 15 Apr (4 nights)');
    const nightAlt = plan(['rowan', 'ellis'], ['2026-04-12', '2026-04-13', '2026-04-14', '2026-04-15'], 'nightBlock');
    nightAlt.chains[0].links[1].gives.activity = '';
    expect(shareText(makeShareContent(input([plan(['rowan', 'ellis'], ['2026-04-08']), nightAlt], { limit: 'all' }))))
      .toContain('Other dates:\n• Sun 12 to Wed 15 Apr (4 nights)');
  });

  it('deduplicates Or dates, prefers an unalerted duplicate, and under All shown lists every other date', () => {
    const alert = [{ date: '2026-12-18', doctors: 6, minimum: 7 }];
    const plans = [
      plan(['rowan', 'ellis'], ['2026-12-10']),
      { ...plan(['rowan', 'ellis'], ['2026-12-18', '2026-12-19']), warnings: alert },
      plan(['rowan', 'ellis'], ['2026-12-18', '2026-12-19']),
      plan(['rowan', 'ellis'], ['2026-12-20']),
      plan(['rowan', 'ellis'], ['2026-12-21']),
      plan(['rowan', 'ellis'], ['2026-12-22']),
    ];
    const content = makeShareContent(input(plans, { limit: 'all' }));
    const row = content.sections[0].rows[0];
    expect(row.alternatives).toEqual([
      { dates: 'Fri 18 + Sat 19 Dec (Long days)', sortDate: '2026-12-18', needsCheck: false },
      { dates: 'Sun 20 Dec (Long day)', sortDate: '2026-12-20', needsCheck: false },
      { dates: 'Mon 21 Dec (Long day)', sortDate: '2026-12-21', needsCheck: false },
      { dates: 'Tue 22 Dec (Long day)', sortDate: '2026-12-22', needsCheck: false },
    ]);
    expect(shareText(content)).toContain('Other dates:\n• Fri 18 + Sat 19 Dec (Long days)\n• Sun 20 Dec (Long day)\n• Mon 21 Dec (Long day)\n• Tue 22 Dec (Long day)');
    expect(content.more).toBe(0);
    expect(shareText(content)).not.toMatch(/\d+ more options/);
  });

  it('respects the active filter and makes top 5, top 10 and all counts refer to rows and hidden options', () => {
    const direct = ['ellis', 'hart', 'moss', 'vale', 'quinn'].map(id => plan(['rowan', id], ['2026-04-13']));
    const threeWay = plan(['rowan', 'ellis', 'hart'], ['2026-04-08']);
    const fourWay = plan(['rowan', 'ellis', 'hart', 'moss'], ['2026-04-09']);
    const alerted = { ...plan(['rowan', 'quinn'], ['2026-04-20']), alerts: [{ staffId: 'quinn', date: '2026-04-20', message: 'Over 72 hours that week.' }] };
    const blocked = blockPlan(['rowan', 'hart']);
    const filtered2 = makeShareContent(input([...direct, threeWay], { filter: 'ask2' }));
    expect(filtered2.sections.flatMap(section => section.rows)).toHaveLength(1);
    expect(filtered2.more).toBe(0);
    expect(makeShareContent(input([...direct, threeWay, fourWay], { filter: 'ask1' })).sections[0].rows).toHaveLength(5);
    expect(makeShareContent(input([...direct, threeWay, fourWay], { filter: 'ask3' })).sections[0].rows[0].ask).toEqual(['Dr Ellis', 'Dr Hart', 'Dr Moss']);
    expect(makeShareContent(input([...direct, alerted], { filter: 'noAlerts' })).sections[0].rows.every(row => row.status === '✓ No issues')).toBe(true);
    expect(makeShareContent(input([...direct, blocked], { filter: 'blocks' })).sections[0].rows[0].keptTogether).toBe(true);
    const samePerson = Array.from({ length: 5 }, (_, index) => plan(['rowan', 'ellis'], [`2026-04-${String(13 + index).padStart(2, '0')}`]));
    const extraRows = [plan(['rowan', 'ellis', 'hart'], ['2026-04-18']), plan(['rowan', 'moss', 'vale'], ['2026-04-19'])];
    const limited = makeShareContent(input([...samePerson, ...direct.slice(1), ...extraRows], { limit: 5 }));
    expect(limited.sections[0].rows).toHaveLength(5);
    expect(limited.sections[0].rows[0].alternatives).toHaveLength(3);
    expect(limited.more).toBe(3);
    const topTen = makeShareContent(input([...samePerson, ...direct.slice(1), ...extraRows], { limit: 10 }));
    expect(topTen.sections.flatMap(section => section.rows)).toHaveLength(7);
    expect(topTen.more).toBe(1);
    const all = makeShareContent(input([...samePerson, ...direct.slice(1), ...extraRows], { limit: 'all' }));
    expect(all.sections[0].rows).toHaveLength(5);
    expect(all.sections[1].rows).toHaveLength(2);
    expect(all.sections.flatMap(section => section.rows).map(row => row.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(all.sections[0].rows[0].alternatives).toHaveLength(4);
    expect(all.more).toBe(0);
    expect(shareText(all)).not.toMatch(/\d+ more options/);
  });

  it('under All shown lists every other date for a person with 17 options and omits the N more line', () => {
    const plans = Array.from({ length: 17 }, (_, index) => {
      const date = `2026-05-${String(index + 1).padStart(2, '0')}`;
      const base = plan(['rowan', 'ellis'], [date]);
      return index === 11 ? { ...base, alerts: [{ staffId: 'ellis', date, message: 'Over 72 hours that week.' }] } : base;
    });
    const all = makeShareContent(input(plans, { limit: 'all' }));
    const topTen = makeShareContent(input(plans, { limit: 10 }));
    expect(all.sections[0].rows).toHaveLength(1);
    expect(all.sections[0].rows[0].alternatives).toHaveLength(16);
    expect(all.sections[0].rows[0].alternatives.map(item => item.sortDate)).toEqual(
      Array.from({ length: 16 }, (_, index) => `2026-05-${String(index + 2).padStart(2, '0')}`),
    );
    expect(all.sections[0].rows[0].alternatives.find(item => item.sortDate === '2026-05-12')?.needsCheck).toBe(true);
    expect(all.more).toBe(0);
    const text = shareText(all);
    expect(text.match(/^• /gm)?.length).toBe(16);
    expect(text).toContain('• Tue 12 May (Long day) ⚠ over 72 h');
    expect(text).not.toMatch(/\d+ more options/);
    expect(topTen.sections[0].rows[0].alternatives).toHaveLength(3);
    expect(topTen.more).toBe(13);
    expect(shareText(topTen)).toContain('13 more options. Ask me for more.');
  });

  it('puts a short reason after ⚠ on Other dates for pay, 72 h, both, and none', () => {
    const clean = plan(['rowan', 'ellis'], ['2026-01-20']);
    const weekend: SwapPlan = { ...plan(['rowan', 'ellis'], ['2026-01-30']), chains: [{ ...plan(['rowan', 'ellis'], ['2026-01-30']).chains[0], payDifferent: true, links: [
      { staffId: 'rowan', gives: unit('rowan', ['2026-01-30'], 'longDay', 'Long day') },
      { staffId: 'ellis', gives: { ...unit('ellis', ['2026-01-30'], 'longDay', 'Gynae Ward CT'), dayType: 'weekend' } },
    ] }] };
    const over72 = { ...plan(['rowan', 'ellis'], ['2026-03-25']), alerts: [{ staffId: 'ellis', date: '2026-03-25', message: 'Over 72 hours that week.' }], chains: [{
      links: [
        { staffId: 'rowan', gives: unit('rowan', ['2026-03-25'], 'longDay', 'Long day') },
        { staffId: 'ellis', gives: unit('ellis', ['2026-03-25'], 'longDay', 'Delivery Suite') },
      ],
      payDifferent: false,
    }] };
    const both: SwapPlan = {
      ...plan(['rowan', 'ellis'], ['2026-04-02']),
      alerts: [{ staffId: 'ellis', date: '2026-04-02', message: 'Over 72 hours that week.' }],
      chains: [{
        links: [
          { staffId: 'rowan', gives: unit('rowan', ['2026-04-02'], 'longDay', 'Long day') },
          { staffId: 'ellis', gives: { ...unit('ellis', ['2026-04-02'], 'longDay', 'Delivery Suite'), dayType: 'weekend' } },
        ],
        payDifferent: true,
      }],
    };
    const bankHoliday: SwapPlan = {
      ...plan(['rowan', 'ellis'], ['2026-12-28']),
      chains: [{
        links: [
          { staffId: 'rowan', gives: unit('rowan', ['2026-12-28'], 'longDay', 'Long day') },
          { staffId: 'ellis', gives: { ...unit('ellis', ['2026-12-28'], 'longDay', 'Delivery Suite'), dayType: 'bankHoliday' } },
        ],
        payDifferent: true,
      }],
    };
    const content = makeShareContent(input([clean, weekend, over72, both, bankHoliday], { limit: 'all' }));
    const alts = content.sections[0].rows[0].alternatives;
    expect(alts).toEqual([
      { dates: 'Fri 30 Jan (Gynae Ward CT)', sortDate: '2026-01-30', needsCheck: true, checkLabel: 'weekend' },
      { dates: 'Wed 25 Mar (Delivery Suite)', sortDate: '2026-03-25', needsCheck: true, checkLabel: 'over 72 h' },
      { dates: 'Thu 2 Apr (Delivery Suite)', sortDate: '2026-04-02', needsCheck: true, checkLabel: 'weekend + over 72 h' },
      { dates: 'Mon 28 Dec (Delivery Suite)', sortDate: '2026-12-28', needsCheck: true, checkLabel: 'bank holiday' },
    ]);
    const text = shareText(content);
    expect(text).toContain('• Fri 30 Jan (Gynae Ward CT) ⚠ weekend');
    expect(text).toContain('• Wed 25 Mar (Delivery Suite) ⚠ over 72 h');
    expect(text).toContain('• Thu 2 Apr (Delivery Suite) ⚠ weekend + over 72 h');
    expect(text).toContain('• Mon 28 Dec (Delivery Suite) ⚠ bank holiday');
    expect(text).toContain('You work: Tue 20 Jan (Long day)');
    expect(text).not.toMatch(/You work:.*⚠/);
    // Main row warning for a pay-only option stays the full wording.
    const weekendMain = makeShareContent(input([weekend], { limit: 'all' }));
    expect(shareText(weekendMain)).toContain('⚠️ Weekend for a weekday');
    expect(shareText(weekendMain)).not.toContain('⚠ weekend');
    const bankHolidayMain = makeShareContent(input([bankHoliday], { limit: 'all' }));
    expect(shareText(bankHolidayMain)).toContain('⚠️ Bank holiday for a weekday');
    expect(shareText(bankHolidayMain)).not.toContain('Weekend for a weekday');
  });

  it('under All shown says more options exist when the search was capped', () => {
    const plans = [plan(['rowan', 'ellis'], ['2026-04-13']), plan(['rowan', 'hart'], ['2026-04-14'])];
    const complete = makeShareContent(input(plans, { limit: 'all' }));
    expect(complete.more).toBe(0);
    expect(complete.moreExistUnloaded).toBeUndefined();
    expect(shareMoreLine(complete)).toBeUndefined();
    expect(shareText(complete)).not.toMatch(/more options/i);
    const capped = makeShareContent(input(plans, { limit: 'all', searchIncomplete: true }));
    expect(capped.more).toBe(0);
    expect(capped.moreExistUnloaded).toBe(true);
    expect(shareMoreLine(capped)).toBe('More options exist. Ask me for more.');
    expect(shareText(capped)).toContain('More options exist. Ask me for more.');
    expect(shareText(capped)).not.toMatch(/\d+ more options/);
    const topTen = makeShareContent(input(plans, { limit: 10, searchIncomplete: true }));
    expect(topTen.moreExistUnloaded).toBeUndefined();
    expect(shareMoreLine(topTen)).toBeUndefined();
  });

  it('defaults share output to ten options', () => {
    expect(DEFAULT_SHARE_LIMIT).toBe(10);
    const people = ['ellis', 'hart', 'moss', 'vale', 'quinn'];
    const pairs = people.flatMap((first, index) => people.slice(index + 1).map(second => plan(['rowan', first, second], ['2026-04-13'])));
    expect(makeShareContent(input(pairs, { limit: DEFAULT_SHARE_LIMIT })).sections[0].rows).toHaveLength(10);
  });

  it('shows an existing shortage once in the share header without marking every plan', () => {
    const cleanPlan = plan(['rowan', 'ellis'], ['2027-04-14']);
    const content = makeShareContent(input([cleanPlan], {
      covered: [{ dates: ['2027-04-08'], activity: 'Delivery Suite', kind: 'longDay' }],
      existingShortages: [{ date: '2027-04-07', doctors: 6, minimum: 7 }],
    }));
    const text = shareText(content);
    expect(cleanPlan.warnings).toEqual([]);
    expect(text.split('\n').filter(line => line.includes('already a doctor short'))).toEqual(['Wed 7 Apr is already a doctor short (6 of 7)']);
    expect(content.sections[0].rows[0].status).toBe('✓ No issues');
  });

  it('sorts alternative dates and adds a year outside the requested shift year', () => {
    const plans = [
      plan(['rowan', 'ellis'], ['2027-04-08']),
      plan(['rowan', 'ellis'], ['2026-12-09']),
      plan(['rowan', 'ellis'], ['2027-03-29']),
      plan(['rowan', 'ellis'], ['2027-08-02']),
      plan(['rowan', 'ellis'], ['2026-11-01']),
    ];
    const content = makeShareContent(input(plans, { covered: [{ dates: ['2027-04-07'], activity: 'Delivery Suite', kind: 'longDay' }], limit: 'all' }));
    expect(content.sections[0].rows[0].alternatives.map(item => item.dates)).toEqual([
      'Sun 1 Nov 2026 (Long day)',
      'Wed 9 Dec 2026 (Long day)',
      'Mon 29 Mar (Long day)',
      'Mon 2 Aug (Long day)',
    ]);
    expect(shareText(content)).toContain('Other dates:\n• Sun 1 Nov 2026 (Long day)\n• Wed 9 Dec 2026 (Long day)\n• Mon 29 Mar (Long day)\n• Mon 2 Aug (Long day)');
  });

  it('keeps These people first options ahead in page order and only Ors matching people', () => {
    const chosen = { ...plan(['rowan', 'vale'], ['2026-04-13']), chosenPeople: true };
    const later = plan(['rowan', 'ellis'], ['2026-04-14']);
    const otherVale = plan(['rowan', 'vale'], ['2026-04-20']);
    const wrongSet = plan(['rowan', 'vale', 'ellis'], ['2026-04-21']);
    const content = makeShareContent(input([chosen, later, otherVale, wrongSet], { limit: 'all' }));
    expect(content.sections[0].rows[0]).toMatchObject({ ask: ['Dr Vale'], instead: 'Mon 13 Apr (Long day)' });
    expect(content.sections[0].rows[0].alternatives).toEqual([{ dates: 'Mon 20 Apr (Long day)', sortDate: '2026-04-20', needsCheck: false }]);
    expect(content.sections[0].rows[1].ask).toEqual(['Dr Ellis']);
    expect(content.sections[1].rows[0].ask).toEqual(['Dr Vale', 'Dr Ellis']);
  });

  it('filters a package of 2-link chains by the two distinct people asked', () => {
    const packagePlan: SwapPlan = {
      chains: [
        { links: [{ staffId: 'rowan', gives: unit('rowan', ['2026-12-04'], 'longDay', 'Labour ward') }, { staffId: 'hart', gives: unit('hart', ['2026-12-11'], 'longDay', 'Labour ward') }], payDifferent: false },
        { links: [{ staffId: 'rowan', gives: unit('rowan', ['2026-12-05'], 'longDay', 'Labour ward') }, { staffId: 'ellis', gives: unit('ellis', ['2026-12-12'], 'longDay', 'Labour ward') }], payDifferent: false },
      ],
      people: 2,
      shiftsMoved: 2,
      cleared: [],
      remaining: [],
      warnings: [],
      blockLength: 2,
    };
    const content = makeShareContent(input([packagePlan], { filter: 'ask2', covered: [{ dates: ['2026-12-04', '2026-12-05'], activity: 'Labour ward', kind: 'longDay' }], limit: 'all' }));
    expect(content.sections.map(section => section.title)).toEqual(['Ask two people']);
    expect(content.sections[0].rows[0].ask).toEqual(['Dr Hart', 'Dr Ellis']);
  });

  it('renders a content-sized four-column PNG and rejects unavailable canvas contexts', async () => {
    const content = makeShareContent(input([blockPlan(['rowan', 'ellis'])], { covered: [{ dates: ['2027-04-08'], activity: 'Delivery Suite', kind: 'longDay' }], existingShortages: [{ date: '2027-04-07', doctors: 6, minimum: 7 }] }));
    const labels: string[] = [];
    const context = {
      fillStyle: '', font: '', textAlign: '', strokeStyle: '', fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), roundRect: vi.fn(), fill: vi.fn(),
      fillText: vi.fn((text: string) => labels.push(text)), measureText: (value: string) => ({ width: value.length * 8 }),
    };
    const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })) } as unknown as HTMLCanvasElement;
    const blob = await renderSharePng(content, () => canvas);
    expect(canvas.width).toBe(720); expect(canvas.height).toBeGreaterThan(250); expect(blob.type).toBe('image/png');
    expect(labels).toContain('YOU WORK INSTEAD'); expect(labels).toContain('Kept together'); expect(labels.join(' | ')).toContain('SWAP OPTIONS');
    expect(labels).toContain('Wed 7 Apr is already a doctor short (6 of 7)');
    expect(labels).not.toContain('✓ No issues');
    await expect(renderSharePng(content, () => ({ width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement))).rejects.toThrow('Could not create the share image.');
  });

  it('wraps a 2-person row and long hyphenated name without collisions or column overflow', async () => {
    const capture = async (plans: SwapPlan[], changes: Partial<ShareInput> = {}) => {
      const calls: { text: string; x: number; y: number; width: number; fontSize: number }[] = [];
      const borders: number[] = [];
      const tags: { x: number; y: number; w: number; h: number }[] = [];
      let context: Record<string, unknown>;
      context = {
        fillStyle: '', font: '', textAlign: '', strokeStyle: '',
        fillRect: vi.fn(), beginPath: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), fill: vi.fn(),
        roundRect: vi.fn((x: number, y: number, w: number, h: number) => { if (w === 94 && h === 18) tags.push({ x, y, w, h }); }),
        moveTo: vi.fn((x: number, y: number) => { if (x === 28) borders.push(y); }),
        measureText: (text: string) => ({ width: text.length * 7 }),
        fillText: (text: string, x: number, y: number) => {
          const font = String(context.font);
          calls.push({ text, x, y, width: text.length * 7, fontSize: Number(font.match(/(\d+)px/)?.[1] ?? 16) });
        },
      };
      const canvas = { width: 0, height: 0, getContext: () => context, toBlob: (callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' })) } as unknown as HTMLCanvasElement;
      await renderSharePng(makeShareContent(input(plans, changes)), () => canvas);
      const rowTop = borders[0];
      const footerTop = borders.at(-1)!;
      const rowCalls = calls.filter(call => call.y >= rowTop + 20 && call.y < footerTop);
      for (const call of rowCalls) {
        const right = call.x < 60 ? 60 : call.x < 70 ? 70 : call.x < 157 ? (plans[0].people > 1 ? 515 : 157) : call.x < 515 ? 515 : 692;
        expect(call.x + call.width, `${call.text} must stay inside its column`).toBeLessThanOrEqual(right);
      }
      for (let first = 0; first < rowCalls.length; first++) for (let second = first + 1; second < rowCalls.length; second++) {
        const a = rowCalls[first]; const b = rowCalls[second];
        const verticalOverlap = Math.abs(a.y - b.y) < (a.fontSize + b.fontSize) / 2;
        const horizontalOverlap = a.x < b.x + b.width && b.x < a.x + a.width;
        expect(verticalOverlap && horizontalOverlap, `overlapping lines: ${a.text} / ${b.text}`).toBe(false);
      }
      return { labels: rowCalls.map(call => call.text), all: calls.map(call => call.text), calls: rowCalls, tags, height: canvas.height, footerTop };
    };

    const twoPerson = await capture([plan(['rowan', 'ellis', 'hart'], ['2026-04-08'])]);
    expect(twoPerson.labels.join(' | ')).toContain('Dr Ellis + Dr Hart');
    expect(twoPerson.labels).toContain('Dr Ellis works your Wed 8 Apr');
    expect(twoPerson.labels).toContain('You work Dr Hart\'s Wed 8 Apr');

    const threePerson = await capture([plan(['rowan', 'ellis', 'hart', 'moss'], ['2026-04-08'])]);
    expect(threePerson.labels.join(' | ')).toContain('Dr Ellis + Dr Hart + Dr Moss');

    const longName = await capture([plan(['rowan', 'ash'], ['2026-04-13'])]);
    expect(longName.labels.join(' ')).toContain('Dr Ashworth- Pemberton');

    const night = await capture([plan(['rowan', 'vale'], ['2027-04-12', '2027-04-13', '2027-04-14', '2027-04-15'], 'nightBlock')], {
      covered: [{ dates: ['2027-04-12', '2027-04-13', '2027-04-14', '2027-04-15'], activity: 'Nights CT', kind: 'nightBlock' }],
    });
    expect(night.labels.join(' | ')).toContain('Mon 12 to Thu 15 Apr (Nights CT)');
    expect(night.labels).not.toContain('Kept together');

    const block = await capture([blockPlan(['rowan', 'ellis'])]);
    expect(block.labels).toContain('Sat 10 + Sun 11 Apr 2027 (Long days)');
    expect(block.labels).toContain('Kept together');
    expect(block.tags[0]?.x).toBe(163);
    const dates = block.calls.find(call => call.text.includes('Sat 10 + Sun 11 Apr'));
    const tagLabel = block.calls.find(call => call.text === 'Kept together');
    expect(dates && tagLabel && tagLabel.y - dates.y).toBeLessThanOrEqual(20);
    expect(block.height).toBeLessThan(block.footerTop + 80);

    const warning = await capture([
      plan(['rowan', 'ellis'], ['2026-04-13']),
      { ...plan(['rowan', 'ellis'], ['2026-04-22']), warnings: [{ date: '2026-04-22', doctors: 6, minimum: 7 }] },
    ]);
    expect(warning.labels).toContain('Other dates:');
    expect(warning.labels.some(label => label === '⚠')).toBe(false);
    expect(warning.labels.some(label => label.startsWith('• ') && label.includes('(Long day)') && label.includes('⚠ 6 of 7 doctors'))).toBe(true);

    const footer = await capture([plan(['rowan', 'ellis'], ['2026-04-13']), ...['hart', 'moss', 'vale', 'quinn', 'ash'].map(id => plan(['rowan', id], ['2026-04-14']))]);
    expect(footer.all).toContain('1 more options. Ask me for more.');
    expect(footer.all.join(' ')).toMatch(/Rota as of|Check MediRota/);
    const left = footer.all.join(' ').indexOf('1 more options. Ask me for more.');
    const right = footer.all.join(' ').indexOf('Rota as of');
    expect(left).toBeGreaterThan(-1);
    expect(right).toBeGreaterThan(-1);

    const many = Array.from({ length: 17 }, (_, index) => plan(['rowan', 'ellis'], [`2026-05-${String(index + 1).padStart(2, '0')}`]));
    const allShown = await capture(many, { limit: 'all' });
    expect(allShown.labels.filter(label => label.startsWith('• '))).toHaveLength(16);
    expect(allShown.all.some(label => /\d+ more options/.test(label))).toBe(false);
    expect(allShown.height).toBeGreaterThan(footer.height);
  });
});
