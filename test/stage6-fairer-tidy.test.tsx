import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FairerGrid } from '../src/app/components/FairerGrid';
import { FairerRatiosTable, getSummary } from '../src/app/pages/FairerRota';
import { consultantReport, prepareFairerModel } from '../src/app/fairer';
import { fairerCellKey, fairerChangedWeeks, fairerCodeKey, fairerCsv, fairerDisplayNote, fairerNextChangeWeek, fairerShareMark, fairerSharesLine, fairerVisibleDoctors, fairerWeekDates, makeFairerDisplay } from '../src/app/fairerDisplay';
import { fitFairerPrint } from '../src/app/fairerPrint';
import { sessionFor } from '../src/app/overview';
import { fairerFixture, fairerConsultantFixture, fairerConsultantBenchmarkFixture } from './fixtures/fairer-made-up';
import { stage6DisplayFixture, stage6FairerFixture } from './fixtures/stage6-fairer';
import invariants from './fixtures/stage6-fairer-invariants.json';

const css = readFileSync('src/app/styles.css', 'utf8');
const source = readFileSync('src/app/pages/FairerRota.tsx', 'utf8');
const fixture = () => { const { ws, model, suggestion } = stage6DisplayFixture(); return { ws, model, suggestion, display: makeFairerDisplay(ws, ws.sessions!, model, suggestion) }; };

describe('Stage 6 Fairer rota display and exports', () => {
  it('38: groups equal shares in one plain sentence per day type', () => {
    const ws = stage6FairerFixture(), settings = ws.sessions!;
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    expect(fairerSharesLine(theatre, settings)).toBe('Theatre: ST1 and ST2 do 2 for every 1 that FY2 and GPVTS do');
    expect(fairerSharesLine(settings.types.find(type => type.name === 'Wards')!, settings)).toBe('Wards: everyone the same');
    // CTO R1: non-whole shares fall back to a plain list, not the sentence.
    settings.ratios[theatre.id] = { fy2: 1.75, gpvts: 1.75, st1: 3.5, st2: 3.5 };
    expect(fairerSharesLine(theatre, settings)).toBe('Theatre: FY2 1.75 · GPVTS 1.75 · ST1 3.5 · ST2 3.5 (bigger number = bigger share)');
    // CTO R1: three distinct values use the list; a zero share uses "don't do".
    settings.ratios[theatre.id] = { fy2: 0, gpvts: 1, st1: 2, st2: 3 };
    expect(fairerSharesLine(theatre, settings)).toBe('Theatre: GPVTS 1 · ST1 2 · ST2 3 (bigger number = bigger share). FY2 don\'t do Theatre');
  });

  it('40 and 42: explains the controls and how the suggestion works in plain words', () => {
    expect(source).toContain('Stops the suggestion putting someone at the same place more than this many days running.');
    expect(source).toContain("Nobody's working hours or days change, only where they work.");
    expect(source).toContain("Working-time rules aren't checked for moved sessions.");
    expect(source).not.toContain('Targets from Sessions');
  });

  it('calls legacy engine notes shares without changing their numbers or source text', () => {
    const note = 'Ratios are 0.2% less even. The targets and ratios stay the same.';
    expect(fairerDisplayNote(note)).toBe('Shares are 0.2% less even. The shares and shares stay the same.');
    expect(note).toContain('Ratios are 0.2%');
  });

  it('44: compares exact distance to the aim, including unchanged distance across the aim', () => {
    expect(fairerShareMark(44, 56, 53)).toBe('✓');
    expect(fairerShareMark(50, 60, 53)).toBe('✗');
    expect(fairerShareMark(44, 44, 53)).toBe('');
    expect(fairerShareMark(44, 62, 53)).toBe('');
    expect(fairerShareMark(53, 53 + 1e-12, 53)).toBe('');
    // CTO R2: tiny unrounded improvement that rounds to the same shown distance → no mark.
    expect(fairerShareMark(50.2, 50.4, 53)).toBe('');
  });

  it('44: gives each type one Aim line in each responsive view and no shading', () => {
    const rows = ['FY2', 'GPVTS', 'ST1'].map((groupName, index) => ({ typeId: 'theatre', typeName: 'Theatre', groupName, groupId: groupName, capacity: 100, before: [44, 50, 44][index]!, after: [56, 60, 44][index]!, aim: 53 }));
    const html = renderToStaticMarkup(createElement(FairerRatiosTable, { rows, types: [{ id: 'theatre', name: 'Theatre' }], groups: rows.map(row => ({ id: row.groupId, name: row.groupName, groupId: row.groupId })) }));
    expect(html.match(/Aim:/g)).toHaveLength(2); // One desktop line and one mobile line, never per cell.
    expect(html.match(/✓<\/span>/g)).toHaveLength(2);
    expect(html.match(/✗<\/span>/g)).toHaveLength(2);
    expect(html).toContain('44% → 56%');
    expect(html).not.toContain('(53%)');
    expect(html).not.toContain('is-off-target');
    expect(css).not.toContain('.fairer-ratios-card td.is-off-target');
    expect(html).toContain('MediRota → suggestion. ✓ closer to the aim, ✗ further from it.');
  });

  it('45: filters the viewer, unchanged doctors and empty grade headings by the shown week', () => {
    const { ws, display } = fixture();
    const dates = fairerWeekDates('2026-11-02');
    expect(fairerVisibleDoctors(display, dates, true).map(person => person.name)).toEqual(['Dr Rowan', 'Dr Ellis']);
    const props = { display, dates, changedOnly: true, viewerId: 'fairer-doctor-0', groups: ws.sessions!.groups };
    const html = renderToStaticMarkup(createElement(FairerGrid, props));
    expect(html).toContain('5 doctors have no changes this week.');
    expect(html).not.toContain('Dr Hart');
    expect(html).not.toContain('>ST1<');
    expect(html).not.toContain('>FY2<'); // Viewer is above the groups, so its now-empty heading goes too.
    expect(html).toContain('>GPVTS<');
    const empty = renderToStaticMarkup(createElement(FairerGrid, { ...props, dates: fairerWeekDates('2026-11-09') }));
    expect(empty).not.toContain('Dr Rowan');
    expect(empty).not.toContain('overview-group');
    expect(empty).toContain('7 doctors have no changes this week.');
    expect(css).toContain('.fairer-day-column { width: 88px; }');
    expect(html.match(/fairer-day-column/g)).toHaveLength(7);
  });

  it('46 and 48: uses Overview codes, full titles, complete keys and tap details', () => {
    const { ws, display } = fixture(), dates = fairerWeekDates('2026-11-02');
    const cell = display.cells.get(fairerCellKey('fairer-doctor-0', dates[0]!))!;
    expect(cell.code).toBe(sessionFor(cell.activity, ws.profile, ws.sessions)?.code);
    const html = renderToStaticMarkup(createElement(FairerGrid, { display, dates, changedOnly: false, groups: ws.sessions!.groups }));
    expect(html).toContain('title="Willow Ward · Was Cedar Theatre"');
    expect(html).toContain('>WW<i');
    expect(html).toContain('title="Mandatory teaching at the invented Riverside education centre"');
    expect(html).toContain('>Train</button>');
    expect(html).toContain('>N</button>');
    for (const { code, label } of fairerCodeKey(display, display.doctors, dates, false)) {
      expect(html).toContain(`${code}</b>`); expect(html).toContain(label);
    }
    expect(html).toContain('Outlined with a dot: moved by the suggestion (tap to see what it was)');
    expect(html).toContain('Dashed outline: extra shift (picked up), never moved');
    expect(html).toContain('is-changed'); expect(html).toContain('is-extra');
    expect(css).toMatch(/\.fairer-cell \{[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
  });

  it('shows unchanged imported days around a partial week while exporting only the chosen range', () => {
    const ws = stage6FairerFixture();
    const model = prepareFairerModel(ws, '2026-11-04', '2026-11-12', 'none', 'none');
    const display = makeFairerDisplay(ws, ws.sessions!, model, model.baseline);
    expect(display.cells.get(fairerCellKey('fairer-doctor-0', '2026-11-02'))?.activity).toBe('Cedar Theatre');
    expect(display.cells.get(fairerCellKey('fairer-doctor-0', '2026-11-02'))?.changed).toBe(false);
    expect(display.dates).toHaveLength(9);
    expect(fairerCsv(display).split('\r\n')[0]).not.toContain('2026-11-02');
  });

  it('49: exports every doctor and day, suggested activity names and the previous activity', () => {
    const { display } = fixture();
    display.doctors[0]!.name = 'Dr Rówan, "Row"';
    display.cells.get(fairerCellKey(display.doctors[0]!.id, display.dates[0]!))!.activity = 'Café, "Willow" Ward';
    const csv = fairerCsv(display);
    expect(csv.startsWith('\uFEFF"Doctor","Grade","2026-11-02"')).toBe(true);
    expect(csv).toContain('"Dr Rówan, ""Row""","FY2","Café, ""Willow"" Ward (was Cedar Theatre)"');
    const lines = csv.slice(1).trimEnd().split('\r\n');
    expect(lines).toHaveLength(display.doctors.length + 1);
    // This fixture has no commas in other names or activities, so its ordinary rows have exactly 23 fields.
    expect(lines[2]!.split(',')).toHaveLength(display.dates.length + 2);
    expect(csv).toContain('"Nights"');
    expect(csv).not.toContain('Nights (was');
    expect(source).toContain('{display && <div className="fairer-export-actions">');
    expect(source).toContain('onClick={() => window.print()}');
  });

  it('49: uses a print-only layout with a page per week, first-page summary and shares, no app or buttons', () => {
    expect(source).toContain('weeks.map((week, index) => <section className="fairer-print-week"');
    expect(source).toContain('{index === 0 && <>');
    expect(source).toContain('viewerGroupId={viewerComparison} printing');
    expect(css).toContain('@page fairer-week { size: A4 landscape; margin: 10mm; }');
    expect(css).toContain('.fairer-printing > :not(.fairer-print-root) { display: none !important; }');
    expect(css).toContain('body.fairer-printing .fairer-print-root button { display: none !important; }');
    expect(css).toContain('body.fairer-printing .fairer-print-week { break-before: page; break-inside: avoid; display: flow-root; }');
    const { ws, display } = fixture();
    const html = renderToStaticMarkup(createElement(FairerGrid, { display, dates: fairerWeekDates('2026-11-02'), changedOnly: false, groups: ws.sessions!.groups, printing: true }));
    expect(html).not.toContain('<button');
    expect(html).toContain('Dr Hayes');
  });


  it('fits a long printed week onto a complete sheet without cutting off rows', () => {
    const sheets = [300, 1000].map(height => ({ style: { zoom: '', removeProperty() { this.zoom = ''; } }, getBoundingClientRect: () => ({ height }) }));
    const root = { querySelectorAll: () => sheets } as unknown as HTMLElement;
    fitFairerPrint(root);
    expect(sheets[0]!.style.zoom).toBe('');
    expect(Number(sheets[1]!.style.zoom) * 1000).toBeLessThan(190 * 96 / 25.4);
    fitFairerPrint(root);
    expect(Number(sheets[1]!.style.zoom) * 1000).toBeCloseTo(188 * 96 / 25.4);
  });

  it('52: finds the next viewer week with changes and wraps, or has none', () => {
    const { display } = fixture();
    const weeks = fairerChangedWeeks(display, 'fairer-doctor-0');
    expect(weeks).toEqual(['2026-11-02', '2026-11-16']);
    expect(fairerNextChangeWeek(weeks, '2026-11-02')).toBe('2026-11-16');
    expect(fairerNextChangeWeek(weeks, '2026-11-09')).toBe('2026-11-16');
    expect(fairerNextChangeWeek(weeks, '2026-11-16')).toBe('2026-11-02');
    expect(fairerChangedWeeks(display, 'fairer-doctor-2')).toEqual([]);
    expect(fairerChangedWeeks(display)).toEqual([]);
    expect(source).toContain('disabled={weekIndex <= 0}');
    expect(source).toContain('disabled={weekIndex >= weeks.length - 1}');
    expect(source).toContain("'No changes for you'");
  });

  it('keeps the main solver, model and fairness summary code identical for every existing fixture', () => {
    for (const [file, digest] of Object.entries(invariants)) {
      const text = file === 'getSummary' ? source.slice(source.indexOf('export function getSummary('), source.indexOf('\nexport function favouredRatioHeadline')) : file === 'solverRequest' ? source.slice(source.indexOf('  const startSolve ='), source.indexOf('  const cancel =')).replace('Balancing session shares', 'Balancing session ratios') : readFileSync(file, 'utf8');
      expect(createHash('sha256').update(text).digest('hex'), file).toBe(digest);
    }
  });

  it.each([
    ['four-week', () => fairerFixture(4, 20)], ['thirteen-week', () => fairerFixture(13, 30)],
    ['consultants', fairerConsultantFixture], ['consultant benchmark', fairerConsultantBenchmarkFixture],
  ] as const)('never changes workspace, assignments, fairness or consultant results while displaying/exporting the %s fixture', (_name, make) => {
    const ws = make(), model = prepareFairerModel(ws, ws.period.start, ws.period.end, 'none', 2, true);
    const suggestion = structuredClone(model.baseline);
    const before = structuredClone({ ws, model, suggestion });
    const summary = getSummary(model, suggestion, ws), consultants = consultantReport(model, suggestion, ws);
    const display = makeFairerDisplay(ws, ws.sessions!, model, suggestion);
    fairerCsv(display); fairerCodeKey(display, display.doctors, display.dates, false); fairerChangedWeeks(display, ws.me);
    expect({ ws, model, suggestion }).toEqual(before);
    expect(getSummary(model, suggestion, ws)).toEqual(summary);
    expect(consultantReport(model, suggestion, ws)).toEqual(consultants);
  });
});
