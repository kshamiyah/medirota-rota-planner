import { legacySessions } from "./fixtures/legacy-sessions";

import { describe, expect, it } from 'vitest';
import {
  analyseSessions, defaultCompactSessionType, equalGradeRatios, formatAxisTick,
  gradeDateRangeLabel, gradeMarkerRect, gradeSessionRates, gradeSummary, gradeTypeFocusLabel,
  gradeValueLabelX, GRADE_CHART_IMAGE_MARGIN, GRADE_COMPACT_CHART_WIDTH, GRADE_MARKER_EXTRA, GRADE_MARKER_WIDTH,
  niceAxisStep, niceAxisTicks, visibleSessionTypes,
} from '../src/app/sessions';
import { gradeChartImageSize, gradeComparisonImageText } from '../src/app/pages/Sessions';
import { overviewFixture } from './fixtures/overview-made-up';

function compareFixture() {
  const ws = structuredClone(overviewFixture());
  ws.profile.groups = [
    { id: 'fy2', name: 'FY2' }, { id: 'gpreg', name: 'GP Reg' }, { id: 'gpvts', name: 'GPVTS' },
    { id: 'st1', name: 'ST1' }, { id: 'st12', name: 'ST1/2' }, { id: 'st2', name: 'ST2' },
  ];
  ws.profile.staff = ws.profile.staff.map((doctor, i) => ({ ...doctor, groupIds: [i === 0 ? 'fy2' : i < 3 ? 'gpreg' : i === 3 ? 'gpvts' : i === 4 ? 'st1' : i === 5 ? 'st12' : 'st2'] }));
  ws.profile.staff = ws.profile.staff.map((doctor, i) => ({ ...doctor, fte: i === 1 ? 0.5 : 1 }));
  for (const doctor of ws.profile.staff) ws.swapFinder!.snapshot.days[doctor.id] = {};
  return ws;
}

describe('Compare grades Stage 2b', () => {
  it('calculates per-4-week rates by group with part-time availability and leave', () => {
    const ws = compareFixture();
    const snapshot = ws.swapFinder!.snapshot;
    const start = '2026-11-09'; const end = '2026-12-06';
    ws.profile.staff[1].fte = 0.5;
    for (let day = 0; day < 4; day++) snapshot.days['doctor-0'][`2026-11-${String(10 + day).padStart(2, '0')}`] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    snapshot.days['doctor-1']['2026-11-09'] = { status: 'leave', activity: 'Annual leave' };
    snapshot.days['doctor-1']['2026-11-10'] = { status: 'leave', activity: 'Annual leave' };
    snapshot.days['doctor-1']['2026-11-11'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    snapshot.days['doctor-1']['2026-11-12'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    for (const day of [10,11,12,13,14,15]) snapshot.days['doctor-2'][`2026-11-${day}`] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    snapshot.days['doctor-3']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    for (const day of [10,11,12,13,14,15,16,17]) snapshot.days['doctor-4'][`2026-11-${day}`] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    const settings = legacySessions(ws.profile);
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    settings.ratios[theatre.id] = { 'session-group-fy2': 1, 'session-group-gps': 1, 'session-group-st12': 2 };
    const analysis = analyseSessions(ws.profile, snapshot, settings, {}, start, end);
    const rows = gradeSessionRates(analysis, settings);
    expect(rows.map(row => [row.name, row.count, row.fte, row.actual[theatre.id]])).toEqual([
      ['FY2', 1, 1, 4], ['GPs', 3, 2.5, 9 / 68 * 28], ['ST1-2', 14, 14, 8 / 392 * 28],
    ]);
    expect(rows.map(row => row.intended[theatre.id])).toEqual([
      21 * 28 / 880, 21 * 28 / 880, 21 * 2 * 28 / 880,
    ]);
  });

  it('excludes extras and both types of locum from actual rates and intended split', () => {
    const ws = compareFixture();
    const snapshot = ws.swapFinder!.snapshot;
    snapshot.days['doctor-0']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    snapshot.days['doctor-0']['2026-11-11'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'], extra: true };
    snapshot.days['doctor-1']['2026-11-10'] = { status: 'longDay', activity: 'Elective C-Sections' };
    ws.profile.staff[1].locum = true; ws.profile.staff[1].regularLocum = true;
    ws.profile.staff[2].locum = true;
    const settings = legacySessions(ws.profile);
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    const result = gradeSessionRates(analyseSessions(ws.profile, snapshot, settings, {}, '2026-11-09', '2026-12-06'), settings);
    expect(result[0].actual[theatre.id]).toBe(1);
    expect(result[0].intended[theatre.id]).toBe(0.0625);
    expect(result[1].totals[theatre.id]).toBe(0);
    expect(result[0].totals[theatre.id]).toBe(1);
  });

  it('labels equal ratios and a 1:1:2 intended split, including split sub-groups', () => {
    const ws = compareFixture(); const settings = legacySessions(ws.profile);
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    expect(equalGradeRatios(theatre.id, settings.groups, settings)).toBe(true);
    settings.ratios[theatre.id] = { 'session-group-fy2': 1, 'session-group-gps': 1, 'session-group-st12': 2 };
    expect(equalGradeRatios(theatre.id, settings.groups, settings)).toBe(false);
    settings.groups[2].subGroups = [
      { id: 'st1-sub', name: 'ST1', grades: ['ST1'] }, { id: 'st2-sub', name: 'ST2', grades: ['ST2'] },
    ];
    const snapshot = ws.swapFinder!.snapshot;
    snapshot.days['doctor-4']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    snapshot.days['doctor-6']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    const rows = gradeSessionRates(analyseSessions(ws.profile, snapshot, settings, {}, '2026-11-09', '2026-12-06'), settings);
    expect(rows.map(row => row.name)).toEqual(['FY2', 'GPs', 'ST1-2 · ST1', 'ST1-2 · ST2']);
    expect(rows[2].intended[theatre.id]).toBe(rows[3].intended[theatre.id]);
  });

  it('filters on-calls, produces the focused summary, and keeps export text anonymous', () => {
    const ws = compareFixture(); const settings = legacySessions(ws.profile);
    const theatre = settings.types.find(type => type.name === 'Theatre')!;
    const nights = settings.types.find(type => type.name === 'Nights')!;
    const types = visibleSessionTypes(settings.types, true);
    expect(types.some(type => type.id === nights.id)).toBe(false);
    expect(types.some(type => type.id === theatre.id)).toBe(true);
    const snapshot = ws.swapFinder!.snapshot;
    snapshot.days['doctor-0']['2026-11-10'] = { status: 'dayJob', activity: 'Elective C-Sections', sessions: ['am','pm'] };
    snapshot.days['doctor-1']['2026-11-10'] = { status: 'night', activity: 'Nights CT', sessions: ['night'] };
    const rows = gradeSessionRates(analyseSessions(ws.profile, snapshot, settings, {}, '2026-11-09', '2026-12-06'), settings);
    expect(gradeSummary('2026-11-09','2026-12-06',theatre,rows,settings)).toBe('9 Nov to 6 Dec 2026: FY2 1.0, GPs 0.0, ST1-2 0.0 theatre sessions per full-time doctor per 4 weeks.');
    settings.ratios[theatre.id] = { 'session-group-fy2': 1, 'session-group-gps': 1, 'session-group-st12': 2 };
    expect(gradeSummary('2026-11-09','2026-12-06',theatre,rows,settings)).toContain('(ratios: FY2 1, GPs 1, ST1-2 2)');
    const summary = gradeSummary('2026-11-09','2026-12-06',theatre,rows,settings);
    const imageText = gradeComparisonImageText(
      { start: '2026-11-09', end: '2026-12-06' }, rows, [theatre], '6 Dec 2026', 'Your ratios',
      { summary, focusedType: theatre },
    );
    const joined = imageText.join('\n');
    for (const doctor of ws.profile.staff) expect(joined).not.toContain(doctor.name);
    expect(imageText[0]).toBe('Compare grades · Theatre');
    expect(imageText[1]).toBe('9 Nov to 6 Dec 2026');
    expect(imageText[2]).toBe(summary);
    expect(imageText.slice(4, 7)).toEqual(rows.map(row => `${row.name}: ${row.count} doctors, ${row.fte.toFixed(1)} FTE`));
    expect(joined).toContain('Sessions per full-time doctor per 4 weeks, adjusted for % time and leave. Extras and locums not included.');
    expect(joined).toContain('Source: MediRota, imported 6 Dec 2026.');
    expect(joined).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('formats dates as 9 Nov to 3 Jan 2027 and never as ISO in chart labels', () => {
    expect(gradeDateRangeLabel('2026-11-09', '2027-01-03')).toBe('9 Nov to 3 Jan 2027');
    expect(gradeDateRangeLabel('2026-11-09', '2027-01-03')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('uses nice axis steps and enough decimals to show each tick exactly', () => {
    expect(niceAxisStep(6.8)).toBe(2);
    expect(niceAxisTicks(6.8)).toEqual([0, 2, 4, 6, 8]);
    expect(niceAxisTicks(6.8).map(tick => formatAxisTick(tick, 2))).toEqual(['0', '2', '4', '6', '8']);
    expect(niceAxisStep(1)).toBe(0.25);
    expect(niceAxisTicks(1)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(niceAxisTicks(1).map(tick => formatAxisTick(tick, 0.25))).toEqual(['0.00', '0.25', '0.50', '0.75', '1.00']);
    expect(formatAxisTick(0.25, 0.25)).not.toBe('0.3');
  });

  it('places value labels after the further of the bar end and the marker', () => {
    expect(gradeValueLabelX(200, 180, 1000)).toBe(214);
    expect(gradeValueLabelX(180, 200, 1000)).toBe(214);
    expect(gradeValueLabelX(990, 995, 1000)).toBe(1000);
  });

  it('draws the intended marker as a short vertical line through its bar', () => {
    const marker = gradeMarkerRect(100, 40, 18);
    expect(marker).toEqual({
      x: 100 - GRADE_MARKER_WIDTH / 2,
      y: 40 - GRADE_MARKER_EXTRA / 2,
      width: GRADE_MARKER_WIDTH,
      height: 18 + GRADE_MARKER_EXTRA,
    });
    expect(GRADE_MARKER_WIDTH).toBe(2);
    // Row pitch must exceed marker height so equal-share marks do not merge into one column.
    expect(18 + 4 + 10).toBeGreaterThan(marker.height);
  });

  it('keeps type focus chevrons evenly spaced by rendering name and chevron together', () => {
    expect(gradeTypeFocusLabel('Theatre')).toBe('Theatre ›');
    expect(gradeTypeFocusLabel('MAU')).toBe('MAU ›');
    expect(gradeTypeFocusLabel('Float')).toBe('Float ›');
    expect(gradeTypeFocusLabel('Wards')).toBe('Wards ›');
  });

  it('defaults the narrow Compare grades picker to Theatre', () => {
    const ws = compareFixture();
    const settings = legacySessions(ws.profile);
    expect(defaultCompactSessionType(settings.types)?.name).toBe('Theatre');
    expect(GRADE_COMPACT_CHART_WIDTH).toBeGreaterThanOrEqual(360);
  });

  it('places copied-image content with a white margin and doctor counts in bar order', () => {
    expect(GRADE_CHART_IMAGE_MARGIN).toBeGreaterThanOrEqual(24);
    expect(gradeChartImageSize(1080, 500)).toEqual({ width: 1080 + 48, height: 500 + 48, margin: 24 });
    const ws = compareFixture();
    const settings = legacySessions(ws.profile);
    settings.groups[2].subGroups = [
      { id: 'st1-sub', name: 'ST1', grades: ['ST1'] }, { id: 'st2-sub', name: 'ST2', grades: ['ST2'] },
    ];
    const rows = gradeSessionRates(analyseSessions(ws.profile, ws.swapFinder!.snapshot, settings, {}, '2026-11-09', '2026-12-06'), settings);
    expect(rows.map(row => row.name)).toEqual(['FY2', 'GPs', 'ST1-2 · ST1', 'ST1-2 · ST2']);
    const counts = gradeComparisonImageText({ start: '2026-11-09', end: '2026-12-06' }, rows, settings.types.slice(0, 1), '6 Dec 2026', 'equal share')
      .filter(line => line.includes(' doctors, '));
    expect(counts).toEqual(rows.map(row => `${row.name}: ${row.count} doctors, ${row.fte.toFixed(1)} FTE`));
  });
});
