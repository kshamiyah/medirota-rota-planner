import { describe, expect, it } from 'vitest';
import { fetchWeekDates, fetchedWeekIsEmpty, formatWeekOf, isFetchBundle, makeFetchBookmark, snapToMonday, stopAfterTwoEmptyWeeks, validWeekDates } from '../src/app/fetchBookmark';
import { isPersonWeek, parsePersonWeek } from '../src/app/medirota';
import { personPage } from './fixtures/medirota-fetch/person-page';

describe('MediRota fetch bookmark', () => {
  it('generates a standalone bookmark with bounded date-only requests', () => {
    const code = makeFetchBookmark('http://localhost:5173/');
    expect(code).toMatch(/^javascript:/);
    expect(code.length).toBeLessThan(10000);
    expect(decodeURIComponent(code)).toContain('credentials:\'same-origin\'');
    expect(decodeURIComponent(code)).toContain('dates.length<=60');
    expect(decodeURIComponent(code)).toContain('event.origin!==appOrigin||event.source!==tab');
    expect(decodeURIComponent(code)).toContain('clearTimeout(timeout)');
    expect(decodeURIComponent(code)).toContain("prefix+start+'/'");
    expect(decodeURIComponent(code)).toContain('activityHtml');
    const script = decodeURIComponent(code.slice('javascript:'.length));
    expect(script).toContain("new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date");
  });
  it('accepts only up to 60 Monday dates', () => {
    expect(validWeekDates(['2026-11-02', '2026-11-09'])).toBe(true);
    expect(validWeekDates(['2026-11-03'])).toBe(false);
    expect(validWeekDates(['2026-02-30'])).toBe(false);
    expect(validWeekDates(Array.from({ length: 61 }, (_, i) => { const d = new Date('2026-11-02T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i * 7); return d.toISOString().slice(0, 10); }))).toBe(false);
  });
  it('snaps an entered Saturday to Monday and counts full weeks from snapped dates', () => {
    expect(snapToMonday('2026-11-07')).toBe('2026-11-02');
    expect(formatWeekOf('2026-11-02')).toBe('Week of Mon 2 Nov');
    expect(fetchWeekDates('2026-11-07', '2026-11-21')).toEqual(['2026-11-02', '2026-11-09', '2026-11-16']);
  });
  it('snaps an entered Wednesday to that week\'s Monday and labels Week of Mon', () => {
    expect(snapToMonday('2026-11-11')).toBe('2026-11-09');
    expect(formatWeekOf(snapToMonday('2026-11-11'))).toBe('Week of Mon 9 Nov');
    expect(fetchWeekDates('2026-11-11', '2026-11-25')).toEqual(['2026-11-09', '2026-11-16', '2026-11-23']);
  });
  it('uses a 60-week default cap and stops only after two parsed empty weeks when more are queued', () => {
    const end = new Date('2026-11-16T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 59 * 7);
    expect(fetchWeekDates('2026-11-16', end.toISOString().slice(0, 10))).toHaveLength(60);
    expect(stopAfterTwoEmptyWeeks([{ start: '2026-11-16', noRota: true }, { start: '2026-11-23', noRota: true }], 4)).toBe(true);
    expect(stopAfterTwoEmptyWeeks([{ start: '2026-11-16', noRota: true }, { start: '2026-11-23', noRota: true }], 2)).toBe(false);
    expect(stopAfterTwoEmptyWeeks([{ start: '2026-11-16', noRota: true }, { start: '2026-11-23', error: 'network' }], 4)).toBe(false);
    expect(stopAfterTwoEmptyWeeks([{ start: '2026-11-16', noRota: true }, { start: '2026-11-23', person: { start: '2026-11-23', people: [] } }], 4)).toBe(false);
    expect(fetchedWeekIsEmpty(200, false)).toBe(true);
    expect(fetchedWeekIsEmpty(404, false)).toBe(true);
    expect(fetchedWeekIsEmpty(500, false)).toBe(false);
    expect(fetchedWeekIsEmpty(200, true)).toBe(false);
    // Two HTTP 404s in a row after published weeks count as empty and stop the default scan.
    expect(stopAfterTwoEmptyWeeks([
      { start: '2026-11-16', person: { start: '2026-11-16', people: [{ id: '1', rowName: 'Rowan', label: 'Dr Rowan', role: 'CT', days: {} }] } },
      { start: '2026-11-23', noRota: fetchedWeekIsEmpty(404, false) },
      { start: '2026-11-30', noRota: fetchedWeekIsEmpty(404, false) },
    ], 6)).toBe(true);
    // A 500 does not count as empty, so the scan continues.
    expect(stopAfterTwoEmptyWeeks([
      { start: '2026-11-16', noRota: true },
      { start: '2026-11-23', noRota: fetchedWeekIsEmpty(500, false) },
    ], 4)).toBe(false);
  });
  it('parses the same person data as saved fake HTML and rejects login and no-rota pages', () => {
    const html = personPage('2026-11-02');
    expect(isPersonWeek(html)).toBe(true);
    const transported = { type: 'week', start: '2026-11-02', status: 200, html };
    const savedFileImport = parsePersonWeek(html);
    const fetchedMessageImport = parsePersonWeek(transported.html);
    expect(fetchedMessageImport).toEqual(savedFileImport);
    expect(isPersonWeek('<html><title>Sign in</title><input name="password"></html>')).toBe(false);
    expect(isPersonWeek('<html><body>No rota</body></html>')).toBe(false);
  });
  it('recognises a fallback JSON bundle', () => {
    expect(isFetchBundle({ version: 1, weeks: [{ start: '2026-11-02', html: personPage('2026-11-02') }] })).toBe(true);
    expect(isFetchBundle({ version: 2, weeks: [{ start: '2026-11-02', html: personPage('2026-11-02'), activityHtml: '<html></html>' }] })).toBe(true);
    expect(isFetchBundle({ version: 1, weeks: [] })).toBe(true);
  });
});
