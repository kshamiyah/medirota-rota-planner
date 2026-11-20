/**
 * Independent Stage 6 tester checks (CTO rulings R1–R8 and brief items 38–52).
 * Made-up data only. Does not rely on the builder's stage6-fairer-tidy.test.tsx alone.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FairerGrid } from '../src/app/components/FairerGrid';
import { FairerRatiosTable } from '../src/app/pages/FairerRota';
import {
  fairerCellKey, fairerChangedWeeks, fairerCodeKey, fairerCsv, fairerNextChangeWeek,
  fairerShareMark, fairerSharesLine, fairerVisibleDoctors, fairerWeekDates, makeFairerDisplay,
} from '../src/app/fairerDisplay';
import { placeCode, shiftCode } from '../src/app/components/codes';
import { sessionFor } from '../src/app/overview';
import { stage6DisplayFixture, stage6FairerFixture } from './fixtures/stage6-fairer';

const css = readFileSync('src/app/styles.css', 'utf8');
const source = readFileSync('src/app/pages/FairerRota.tsx', 'utf8');
const displaySource = readFileSync('src/app/fairerDisplay.ts', 'utf8');
const settingsShape = () => {
  const ws = stage6FairerFixture();
  return ws.sessions!;
};

describe('Stage 6 tester: shares lines (38 / R1)', () => {
  it('heading and link wording', () => {
    expect(source).toContain('Shares from Sessions');
    expect(source).toContain('Edit in Settings → Sessions');
    expect(source).not.toContain('Targets from Sessions');
  });

  it('everyone the same when all shares equal', () => {
    const settings = settingsShape();
    const wards = settings.types.find(type => type.name === 'Wards')!;
    expect(fairerSharesLine(wards, settings)).toBe('Wards: everyone the same');
  });

  it('plain sentence only for exactly two distinct whole-number shares', () => {
    const settings = settingsShape();
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    expect(fairerSharesLine(theatre, settings)).toBe('Theatre: ST1 and ST2 do 2 for every 1 that FY2 and GPVTS do');
  });

  it('falls back to a plain list for three or more distinct values', () => {
    const settings = settingsShape();
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    settings.ratios[theatre.id] = { fy2: 1, gpvts: 2, st1: 3, st2: 3 };
    expect(fairerSharesLine(theatre, settings)).toBe('Theatre: FY2 1 · GPVTS 2 · ST1 3 · ST2 3 (bigger number = bigger share)');
  });

  it('falls back to a plain list when any share is not a whole number', () => {
    const settings = settingsShape();
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    settings.ratios[theatre.id] = { fy2: 1.75, gpvts: 1.75, st1: 1, st2: 1 };
    expect(fairerSharesLine(theatre, settings)).toBe('Theatre: FY2 1.75 · GPVTS 1.75 · ST1 1 · ST2 1 (bigger number = bigger share)');
  });

  it('zero share uses "don\'t do" and single grade says everyone the same', () => {
    const settings = settingsShape();
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    settings.groups = [{ id: 'fy2', name: 'FY2', grades: ['FY2'] }];
    settings.ratios[theatre.id] = { fy2: 1 };
    expect(fairerSharesLine(theatre, settings)).toBe('Theatre: everyone the same');
    settings.groups = [
      { id: 'fy2', name: 'FY2', grades: ['FY2'] },
      { id: 'st1', name: 'ST1', grades: ['ST1'] },
    ];
    settings.ratios[theatre.id] = { fy2: 0, st1: 1 };
    expect(fairerSharesLine(theatre, settings)).toBe("Theatre: everyone the same. FY2 don't do Theatre");
  });
});

describe('Stage 6 tester: wording (40, 42)', () => {
  it('40: days-in-a-row help line', () => {
    expect(source).toContain('Stops the suggestion putting someone at the same place more than this many days running.');
  });

  it('42: How this works has the four plain statements', () => {
    expect(source).toContain('Only day jobs at a single place can move. Nights, long days, on-calls, part shifts, extra shifts, locums, leave, training and zero days stay exactly as imported.');
    expect(source).toContain("Nobody's working hours or days change, only where they work.");
    expect(source).toContain("Working-time rules aren't checked for moved sessions.");
    expect(source).toContain("This is a suggestion. It isn't saved and doesn't change your imported rota.");
  });

  it('no em dashes or visible target/ratio wording in new Fairer display helpers', () => {
    expect(displaySource).not.toContain('\u2014');
    expect(source).not.toMatch(/Targets from Sessions/);
    const visibleChunks = [
      ...source.match(/Shares from Sessions[\s\S]{0,200}/g) ?? [],
      ...source.match(/How this works[\s\S]{0,800}/g) ?? [],
      ...source.match(/fairer-share-key[\s\S]{0,120}/g) ?? [],
    ].join('\n');
    expect(visibleChunks).not.toMatch(/\bratio\b/i);
    expect(visibleChunks).not.toMatch(/\btarget\b/i);
  });
});

describe('Stage 6 tester: share table (44 / R2)', () => {
  it('tick when closer by at least 1 shown point, cross when further, blank otherwise', () => {
    expect(fairerShareMark(44, 56, 53)).toBe('✓');
    expect(fairerShareMark(50, 60, 53)).toBe('✗');
    expect(fairerShareMark(44, 44, 53)).toBe('');
    expect(fairerShareMark(44, 62, 53)).toBe('');
    expect(fairerShareMark(50.2, 50.4, 53)).toBe(''); // closer unrounded, same shown distance
    expect(fairerShareMark(50.4, 50.2, 53)).toBe(''); // further unrounded, same shown distance
    expect(fairerShareMark(40, 50, 53)).toBe('✓');
    expect(fairerShareMark(50, 70, 53)).toBe('✗');
  });

  it('cells show MediRota → suggestion, aim once per type, key, no shading', () => {
    const rows = [
      { groupId: 'fy', groupName: 'FY2', typeId: 'theatre', typeName: 'Theatre', before: 44, after: 56, aim: 53, capacity: 100 },
      { groupId: 'st', groupName: 'ST1', typeId: 'theatre', typeName: 'Theatre', before: 50, after: 60, aim: 53, capacity: 100 },
      { groupId: 'fy', groupName: 'FY2', typeId: 'wards', typeName: 'Wards', before: 0, after: 0, aim: 0, capacity: 0 },
    ];
    const html = renderToStaticMarkup(createElement(FairerRatiosTable, {
      rows, types: [{ id: 'theatre', name: 'Theatre' }, { id: 'wards', name: 'Wards' }],
      groups: [{ id: 'fy', name: 'FY2', groupId: 'fy' }, { id: 'st', name: 'ST1', groupId: 'st' }],
    }));
    expect(html).toContain('44% → 56%');
    expect(html).not.toContain('(53%)');
    expect(html.match(/Aim:/g)).toHaveLength(2);
    expect(html).toContain('Aim: FY2 53% · ST1 53%');
    expect(html).toContain('MediRota → suggestion. ✓ closer to the aim, ✗ further from it.');
    expect(html).not.toContain('is-off-target');
    expect(css).not.toContain('is-off-target');
    expect(html).toContain('aria-label="closer to the aim"');
    expect(html).toContain('aria-label="further from the aim"');
  });

  it('uses percentage distances so capacity other than 100 still marks correctly', () => {
    const rows = [
      { groupId: 'fy', groupName: 'FY2', typeId: 'theatre', typeName: 'Theatre', before: 10, after: 6, aim: 7.5, capacity: 50 },
    ];
    const html = renderToStaticMarkup(createElement(FairerRatiosTable, {
      rows, types: [{ id: 'theatre', name: 'Theatre' }],
      groups: [{ id: 'fy', name: 'FY2', groupId: 'fy' }],
    }));
    expect(html).toContain('20% → 12%');
    expect(html).toContain('aria-label="closer to the aim"');
  });
});

describe('Stage 6 tester: changed cells only (45)', () => {
  it('hides unchanged doctors and empty headings, keeps day column width, singular count', () => {
    const { ws, display } = (() => {
      const { ws, model, suggestion } = stage6DisplayFixture();
      return { ws, display: makeFairerDisplay(ws, ws.sessions!, model, suggestion) };
    })();
    const dates = fairerWeekDates('2026-11-02');
    expect(fairerVisibleDoctors(display, dates, true).map(p => p.name)).toEqual(['Dr Rowan', 'Dr Ellis']);
    const html = renderToStaticMarkup(createElement(FairerGrid, {
      display, dates, changedOnly: true, viewerId: 'fairer-doctor-0', groups: ws.sessions!.groups,
    }));
    expect(html).toContain('5 doctors have no changes this week.');
    expect(html).not.toContain('Dr Hart');
    expect(html).not.toContain('>FY2<');
    expect(html).toContain('>GPVTS<');
    expect(css).toContain('.fairer-day-column { width: 88px; }');
    expect(html.match(/fairer-day-column/g)).toHaveLength(7);

    const one = structuredClone(display);
    one.doctors = one.doctors.filter(person => person.id === 'fairer-doctor-0' || person.id === 'fairer-doctor-1');
    const singular = renderToStaticMarkup(createElement(FairerGrid, {
      display: one, dates, changedOnly: true, viewerId: 'fairer-doctor-0', groups: ws.sessions!.groups,
    }));
    expect(singular).toContain('0 doctors have no changes this week.');
    const onlyRowanChanged = structuredClone(display);
    for (const date of dates) {
      const cell = onlyRowanChanged.cells.get(fairerCellKey('fairer-doctor-1', date));
      if (cell) cell.changed = false;
    }
    onlyRowanChanged.doctors = onlyRowanChanged.doctors.slice(0, 2);
    const oneHidden = renderToStaticMarkup(createElement(FairerGrid, {
      display: onlyRowanChanged, dates, changedOnly: true, viewerId: 'fairer-doctor-0', groups: ws.sessions!.groups,
    }));
    expect(oneHidden).toContain('1 doctor has no changes this week.');
  });
});

describe('Stage 6 tester: cell codes and marks (46, 48 / R8)', () => {
  it('imports Overview codes helper and never copies it', () => {
    expect(displaySource).toMatch(/import \{[^}]*placeCode[^}]*\} from '\.\/components\/codes'/);
    expect(displaySource).toMatch(/import \{[^}]*shiftCode[^}]*\} from '\.\/components\/codes'/);
    expect(displaySource).not.toMatch(/function placeCode/);
    expect(displaySource).not.toMatch(/Delivery Suite.*→.*DS/);
  });

  it('cells use short codes, full title, no RTL clip, key lists shown codes only', () => {
    const { ws, model, suggestion } = stage6DisplayFixture();
    const display = makeFairerDisplay(ws, ws.sessions!, model, suggestion);
    const dates = fairerWeekDates('2026-11-02');
    const cell = display.cells.get(fairerCellKey('fairer-doctor-0', dates[0]!))!;
    expect(cell.code).toBe(sessionFor(cell.activity, ws.profile, ws.sessions)?.code);
    expect(cell.code).toBe(placeCode({ id: 'x', name: cell.activity }, []));
    const html = renderToStaticMarkup(createElement(FairerGrid, {
      display, dates, changedOnly: false, groups: ws.sessions!.groups,
    }));
    expect(html).toContain('title="');
    expect(html).toContain('Was Cedar Theatre');
    expect(css).toMatch(/\.fairer-cell \{[^}]*overflow-wrap: anywhere/);
    expect(css).not.toMatch(/\.fairer-cell \{[^}]*direction:\s*rtl/);
    expect(css).not.toMatch(/\.fairer-cell \{[^}]*text-overflow:\s*ellipsis/);
    const codes = fairerCodeKey(display, display.doctors, dates, false);
    for (const entry of codes) {
      expect(html).toContain(`>${entry.code}</b>`);
      expect(html).toContain(entry.label);
    }
    expect(html).toContain('Outlined with a dot: moved by the suggestion (tap to see what it was)');
    expect(html).toContain('Dashed outline: extra shift (picked up), never moved');
    expect(shiftCode('Nights')).toBe('N');
  });
});

describe('Stage 6 tester: CSV and print (49 / R4 / R5)', () => {
  it('CSV has BOM, escapes, was-text, chosen-range filename pattern, browser-only download', () => {
    const { ws, model, suggestion } = stage6DisplayFixture();
    const display = makeFairerDisplay(ws, ws.sessions!, model, suggestion);
    display.doctors[0]!.name = 'Dr Zoë Hart';
    const date = display.dates[0]!;
    const cell = display.cells.get(fairerCellKey(display.doctors[0]!.id, date))!;
    cell.activity = 'Ward 5, East';
    cell.changed = true;
    cell.previous = 'quotes "here"';
    const csv = fairerCsv(display);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"Dr Zoë Hart"');
    expect(csv).toContain('"Ward 5, East (was quotes ""here"")"');
    expect(source).toContain('downloadFairerCsv(display)');
    expect(displaySource).toContain('fairer-rota-${display.dates[0]}-to-${display.dates.at(-1)}.csv');
    expect(displaySource).toContain('URL.createObjectURL');
    expect(displaySource).not.toMatch(/fetch\(/);
  });

  it('print CSS is landscape A4, one week per page, scoped so other pages are unchanged', () => {
    expect(css).toContain('@page fairer-week { size: A4 landscape; margin: 10mm; }');
    expect(css).toContain('page: fairer-week');
    expect(css).toContain('body.fairer-printing .fairer-print-week { break-before: page');
    expect(css).toContain('body.fairer-printing .fairer-print-root { display: block');
    expect(css).toMatch(/body\.fairer-printing|body:has\(\.fairer-page\)/);
    expect(css).not.toMatch(/^@page \{ size: A4 landscape/m);
    const printBlocks = [...css.matchAll(/@media print \{([\s\S]*?)(?=\n@media|\n@page|\n\.fairer-settings,|\n\/\*|$)/g)].map(m => m[1]);
    const unscopedHideButtons = printBlocks.some(block =>
      /(?:^|\n)\s*button \{ display: none/m.test(block)
      && !/fairer-print-root button/.test(block)
      && !/body\.fairer-printing/.test(block)
      && !/:has\(\.fairer-page\)/.test(block));
    expect(unscopedHideButtons).toBe(false);
    expect(source).toContain('{display && <div className="fairer-export-actions">');
    expect(source).toContain('window.print()');
  });
});

describe('Stage 6 tester: week controls (52 / R3)', () => {
  it('previous/next disabled at ends; jump wraps; hidden with no viewer', () => {
    const { display } = (() => {
      const { ws, model, suggestion } = stage6DisplayFixture();
      return { display: makeFairerDisplay(ws, ws.sessions!, model, suggestion) };
    })();
    const weeks = fairerChangedWeeks(display, 'fairer-doctor-0');
    expect(weeks).toEqual(['2026-11-02', '2026-11-16']);
    expect(fairerNextChangeWeek(weeks, '2026-11-16')).toBe('2026-11-02');
    expect(fairerChangedWeeks(display)).toEqual([]);
    expect(source).toContain('disabled={weekIndex <= 0}');
    expect(source).toContain('disabled={weekIndex >= weeks.length - 1}');
    expect(source).toContain("'No changes for you'");
    expect(source).toContain('{viewPerson && <button type="button" disabled={!changedWeeks.length}');
    expect(source).toContain("'Jump to my changes'");
  });
});
