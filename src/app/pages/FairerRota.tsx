import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addDays, dateRange, weekday } from '../../engine/calendar';
import type { Assignment, ISODate } from '../../engine/types';
import { defaultSessionsSettings, sessionComparisonFor, sessionDateRange, sessionGroupOptions, type SessionsSettings } from '../sessions';
import { combineFairerAssignments, consultantReport, fairerProgressPercent, fairerRemainingTimeLimit, latestImportedAt, prepareFairerModel, validateFairerResult, type ConsultantReport, type FairerModel } from '../fairer';
import { update, useWorkspace } from '../store';
import type { Page } from './types';
import type { WorkerMessage, WorkerRequest } from '../solver.worker';
import { Empty } from '../components/ui';
import { FairerGrid } from '../components/FairerGrid';
import { fitFairerPrint } from '../fairerPrint';
import { downloadFairerCsv, fairerChangedWeeks, fairerDisplayNote, fairerNextChangeWeek, fairerShareMark, fairerSharesLine, fairerWeekDates, makeFairerDisplay, unchangedFromBaseline } from '../fairerDisplay';

const todayMonday = (): ISODate => {
  const now = new Date();
  const date = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
};
const dateLabel = (date: ISODate) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

export interface SummaryRow { groupId: string; groupName: string; typeId: string; typeName: string; before: number; after: number; aim: number; capacity: number }

export function getSummary(model: FairerModel, after: Assignment[], ws: ReturnType<typeof useWorkspace>): SummaryRow[] {
  const settings = ws.sessions ?? defaultSessionsSettings(ws.profile);
  const groupOptions = settings.groups.flatMap(group => group.subGroups?.length ? group.subGroups.map(sub => ({ id: sub.id, name: `${group.name} · ${sub.name}`, groupId: group.id })) : [{ id: group.id, name: group.name, groupId: group.id }]);
  const personGroup = new Map(ws.profile.staff.map(person => [person.id, sessionComparisonFor(person, ws.profile, settings, ws.sessionSubGroups ?? {})]));
  const sessionCounts = (items: Assignment[], typeId: string, groupId: string) => items.filter(item => model.typeForRole[item.roleId ?? ''] === typeId && personGroup.get(item.staffId)?.comparisonId === groupId && model.movable.some(base => base.staffId === item.staffId && base.date === item.date)).length;
  const capacities = groupOptions.map(group => ({ group, sessions: model.movable.filter(item => personGroup.get(item.staffId)?.comparisonId === group.id).length }));
  return model.dayTypes.flatMap(type => {
    const baseCounts = groupOptions.map(group => ({ group, sessions: sessionCounts(model.movable, type.id, group.id) }));
    const total = baseCounts.reduce((sum, item) => sum + item.sessions, 0);
    const weights = capacities.map(({ group, sessions }) => sessions * (model.ratios[type.id]?.[group.groupId] ?? 1));
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    return groupOptions.map((group, index) => ({ groupId: group.id, groupName: group.name, typeId: type.id, typeName: type.name,
      before: sessionCounts(model.movable, type.id, group.id), after: sessionCounts(after, type.id, group.id),
      aim: weightTotal ? total * weights[index]! / weightTotal : 0, capacity: capacities[index]!.sessions }));
  });
}

export function favouredRatioHeadline(settings: SessionsSettings, rows: SummaryRow[], viewerGroupId?: string): string | undefined {
  if (!viewerGroupId) return undefined;
  const groups = sessionGroupOptions(settings);
  const viewer = groups.find(group => group.id === viewerGroupId);
  if (!viewer) return undefined;
  const otherGroups = groups.filter(group => group.groupId !== viewer.groupId);
  if (!otherGroups.length) return undefined;
  const favoured = settings.types.filter(type => type.kind === 'day' && otherGroups.every(group => (settings.ratios[type.id]?.[viewer.groupId] ?? 1) > (settings.ratios[type.id]?.[group.groupId] ?? 1)));
  if (!favoured.length) return undefined;
  const ordered = [viewer, ...groups.filter(group => group.id !== viewer.id)];
  const values = (field: 'before' | 'after' | 'aim') => ordered.map(group => favoured.reduce((sum, type) => {
    const row = rows.find(item => item.groupId === group.id && item.typeId === type.id);
    return sum + (row?.capacity ? row[field] / row.capacity : 0);
  }, 0));
  const format = (input: number[]) => {
    const scale = input[1] || 1;
    return input.map(value => (value / scale).toFixed(1)).join(' : ');
  };
  return `${viewer.name} in ${favoured.map(type => type.name).join(' + ')}: ${format(values('before'))} → ${format(values('after'))} (aim ${format(values('aim'))})`;
}

export function fairerSettingsLine(start: ISODate, end: ISODate, limit: number | 'none', consultantsOn: boolean | 'not-used'): string {
  return `${dateLabel(start)} to ${dateLabel(end)} · ${limit === 'none' ? 'No limit' : `${limit}% limit`} · ${consultantsOn === 'not-used' ? 'Same consultants: not used this time' : `Same consultants ${consultantsOn ? 'on' : 'off'}`}`;
}
export function fairerConsultantSetting(fallbackCheck: string | undefined, requested: boolean): boolean | 'not-used' {
  return fallbackCheck ? 'not-used' : requested;
}
export function fairerSettingsCollapsed(hasResult: boolean, editing: boolean): boolean { return hasResult && !editing; }
export function fairerGridInitialState(): { open: false; changedOnly: true } { return { open: false, changedOnly: true }; }
/** Estimate shown next to Change at most. Empty for No limit so "No limit" is not repeated. */
export function fairerChangeLimitHint(limit: number | 'none', estimate: number): string {
  return limit === 'none' ? '' : `Move at most ${Math.floor(estimate * limit / 100)} of the ${estimate} day sessions (${limit}%)`;
}
/** Mondays used as Week picker values for a date range. */
export function fairerWeekOptions(dates: ISODate[]): ISODate[] {
  return [...new Set(dates.map(date => addDays(date, -weekday(date))))];
}
/** First date in the range that belongs to weekMonday; used so mid-week starts still scroll. */
export function fairerWeekAnchorDate(weekMonday: ISODate, dates: ISODate[]): ISODate | undefined {
  return dates.find(date => addDays(date, -weekday(date)) === weekMonday);
}
export function fairerWeekHeaderId(weekMonday: ISODate): string {
  return `fairer-week-${weekMonday}`;
}
export function fairerWeekScrollTarget(scrollLeft: number, wrapLeft: number, anchorLeft: number, stickyColumnWidth: number): number {
  return Math.max(0, scrollLeft + anchorLeft - wrapLeft - stickyColumnWidth);
}

function runStats(dayJobs: Assignment[], assignments: Assignment[], model: FairerModel): { qualifying: number; threePlus: number; longest: number } {
  const workingDays = new Map<string, Set<ISODate>>();
  const placeDays = new Map<string, Map<string, Set<ISODate>>>();
  for (const item of dayJobs) {
    if (weekday(item.date) > 4) continue;
    const days = workingDays.get(item.staffId) ?? new Set<ISODate>(); days.add(item.date); workingDays.set(item.staffId, days);
  }
  const eligibleDay = new Set(dayJobs.map(item => `${item.staffId}|${item.date}`));
  for (const item of assignments) {
    if (!eligibleDay.has(`${item.staffId}|${item.date}`) || weekday(item.date) > 4 || !item.roleId || !model.typeForRole[item.roleId]) continue;
    const place = model.placeForRole[item.roleId];
    if (!place) continue;
    const byPlace = placeDays.get(item.staffId) ?? new Map<string, Set<ISODate>>();
    const dates = byPlace.get(place) ?? new Set<ISODate>(); dates.add(item.date); byPlace.set(place, dates); placeDays.set(item.staffId, byPlace);
  }
  let qualifying = 0, threePlus = 0, longest = 0;
  for (const [staffId, dates] of workingDays) {
    const weeks = new Map<ISODate, Set<ISODate>>();
    for (const date of dates) { const week = addDays(date, -weekday(date)); const days = weeks.get(week) ?? new Set<ISODate>(); days.add(date); weeks.set(week, days); }
    for (const [week, weekdays] of weeks) {
      if (weekdays.size < 3) continue;
      qualifying++;
      const threeAtPlace = [...(placeDays.get(staffId)?.values() ?? [])].some(placeDates => [...placeDates].filter(date => date >= week && date <= addDays(week, 4)).length >= 3);
      if (threeAtPlace) threePlus++;
    }
    for (const datesAtPlace of placeDays.get(staffId)?.values() ?? []) {
      let run = 0, previous: ISODate | undefined;
      for (const date of [...datesAtPlace].sort()) { run = previous && addDays(previous, 1) === date ? run + 1 : 1; longest = Math.max(longest, run); previous = date; }
    }
  }
  return { qualifying, threePlus, longest };
}

export type FairerConsultantListState = { kind: 'none' | 'configured-without-match' } | { kind: 'allocated'; date: ISODate } | { kind: 'configure'; date?: ISODate };
export function fairerConsultantListState(hasLists: boolean, hasSameConsultantsSettings: boolean, importedDate?: ISODate, allocationDate?: ISODate): FairerConsultantListState {
  if (!hasLists) return { kind: 'none' };
  if (!hasSameConsultantsSettings) return { kind: 'configure', ...(importedDate ? { date: importedDate } : {}) };
  return allocationDate ? { kind: 'allocated', date: allocationDate } : { kind: 'configured-without-match' };
}

export function FairerRota({ go, openSessions }: { go: (page: Page) => void; openSessions: (anchor: string) => void }) {
  const ws = useWorkspace();
  const snapshot = ws.swapFinder?.snapshot;
  const imported = snapshot ? sessionDateRange(snapshot) : undefined;
  const loaded = !!imported;
  const todayStart = todayMonday();
  const defaultStart = imported ? (todayStart < imported.start ? imported.start : todayStart > imported.end ? imported.end : todayStart) : todayStart;
  const defaultEnd = imported ? (addDays(defaultStart, 90) < imported.end ? addDays(defaultStart, 90) : imported.end) : addDays(defaultStart, 90);
  const [start, setStart] = useState<ISODate>(ws.fairerSettings?.start ?? defaultStart);
  const [end, setEnd] = useState<ISODate>(ws.fairerSettings?.end ?? defaultEnd);
  const storedLimit = ws.fairerSettings?.changeLimit ?? 20;
  const [limit, setLimit] = useState<number | 'none'>(storedLimit);
  const [lastLimitedPercent, setLastLimitedPercent] = useState(typeof storedLimit === 'number' ? storedLimit : ws.fairerSettings?.lastLimitedPercent ?? 20);
  const [maxDays, setMaxDays] = useState<2 | 3 | 4 | 'none'>(ws.fairerSettings?.maxDays ?? 2);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ label: string; elapsed: number }>();
  const [error, setError] = useState('');
  const [resultNotes, setResultNotes] = useState<string[]>([]);
  const [consultantFallbackCheck, setConsultantFallbackCheck] = useState<string>();
  const [model, setModel] = useState<FairerModel>();
  const [suggestion, setSuggestion] = useState<Assignment[]>();
  const [changedOnly, setChangedOnly] = useState<boolean>(fairerGridInitialState().changedOnly);
  const [settingsEditOpen, setSettingsEditOpen] = useState(false);
  const [gridOpen, setGridOpen] = useState(false);
  const [weekJump, setWeekJump] = useState<ISODate>('');
  const workerRef = useRef<Worker | null>(null);
  const solveStartedRef = useRef(0);
  const latest = snapshot ? latestImportedAt(snapshot) : undefined;
  const settings = ws.sessions ?? defaultSessionsSettings(ws.profile);
  const consistency = settings.sameConsultants ?? { groupIds: [], typeIds: [] };
  const hasAnyConsultantLists = (ws.consultantLists ?? []).some(cell => cell.consultants.length > 0);
  const hasConsultantLists = (ws.consultantLists ?? []).some(cell => consistency.typeIds.includes(settings.types.find(type => type.placeIds.includes(cell.placeId))?.id ?? '') && cell.consultants.length > 0);
  const [keepSameConsultants, setKeepSameConsultants] = useState(ws.fairerSettings?.keepSameConsultants ?? (!!consistency.groupIds.length && hasConsultantLists));
  const allocationDate = (ws.consultantLists ?? []).filter(cell => consistency.typeIds.includes(settings.types.find(type => type.placeIds.includes(cell.placeId))?.id ?? '') && cell.consultants.length > 0).map(cell => cell.date).sort().at(-1);
  const latestConsultantListDate = (ws.consultantLists ?? []).filter(cell => cell.consultants.length > 0).map(cell => cell.date).sort().at(-1);
  const consultantListState = fairerConsultantListState(hasAnyConsultantLists, !!consistency.groupIds.length && !!consistency.typeIds.length, latestConsultantListDate, allocationDate);
  const consistencyLabel = `Keep ${settings.groups.filter(group => consistency.groupIds.includes(group.id)).map(group => group.name).join(' and ')} with the same consultants in ${settings.types.filter(type => consistency.typeIds.includes(type.id)).map(type => type.name).join(' and ')}`;
  const types = settings.types.filter(type => type.kind === 'day');
  const dateList = useMemo(() => imported && start <= end ? dateRange(start, end) : [], [start, end, imported?.start, imported?.end]);
  const movedCount = model && suggestion ? model.movable.length - model.movable.filter(item => suggestion.some(result => unchangedFromBaseline(item, result, model))).length : 0;
  const summary = useMemo(() => model && suggestion ? getSummary(model, suggestion, ws) : [], [model, suggestion, ws]);
  const consultantSummary = useMemo(() => model && suggestion ? consultantReport(model, suggestion, ws) : undefined, [model, suggestion, ws]);
  const estimate = useMemo(() => snapshot && imported ? estimateMovable(ws, start, end) : 0, [snapshot, imported?.start, imported?.end, ws.profile, ws.sessions, ws.sessionSubGroups, start, end]);
  const saveSettings = (changes: Partial<{ start: ISODate; end: ISODate; changeLimit: number | 'none'; maxDays: 2 | 3 | 4 | 'none'; keepSameConsultants: boolean }>) => {
    const next = { start, end, changeLimit: limit, maxDays, keepSameConsultants, ...changes };
    update(w => { w.fairerSettings = { ...next, lastLimitedPercent: typeof next.changeLimit === 'number' ? next.changeLimit : lastLimitedPercent }; });
  };
  const chooseLimit = (value: number | 'none') => {
    setLimit(value);
    if (typeof value === 'number') setLastLimitedPercent(value);
    saveSettings({ changeLimit: value });
  };
  const startSolve = () => {
    if (!snapshot || !imported || start < imported.start || end > imported.end || start > end) return;
    setError(''); setResultNotes([]); setConsultantFallbackCheck(undefined); setSuggestion(undefined); setModel(undefined); setChangedOnly(true); setGridOpen(false); setSettingsEditOpen(false);
    const runStarted = Date.now(); solveStartedRef.current = runStarted;
    let nextModel: FairerModel;
    try { nextModel = prepareFairerModel(ws, start, end, limit, maxDays, limit === 'none' && keepSameConsultants); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not prepare this rota.'); return; }
    if (!nextModel.movable.length) { setError('There are no mapped day jobs to move in this date range.'); return; }
    const weeks = Math.ceil(dateList.length / 7);
    const remainingTimeLimit = fairerRemainingTimeLimit(weeks, (Date.now() - runStarted) / 1000);
    if (remainingTimeLimit <= 0) { setError('Too many weeks to plan in time. Try a shorter range.'); return; }
    const worker = new Worker(new URL('../solver.worker.ts', import.meta.url), { type: 'module' });
    workerRef.current = worker; setRunning(true); setProgress({ label: 'Starting', elapsed: (Date.now() - runStarted) / 1000 });
    worker.onmessage = (event: MessageEvent<WorkerMessage>) => {
      const message = event.data;
      if (message.type === 'progress') { setProgress({ label: message.done ? 'Finishing' : message.tier === 'fairness' ? 'Balancing session shares' : message.tier === 'paired' ? 'Keeping paired consultants' : message.tier === 'consultants' ? 'Keeping the same consultants' : message.tier === 'preference' ? 'Improving variety' : 'Reducing changes', elapsed: (Date.now() - solveStartedRef.current) / 1000 }); return; }
      worker.terminate(); workerRef.current = null; setRunning(false);
      if (message.type === 'done') {
        const assignments = combineFairerAssignments(nextModel, message.result.assignments);
        const issue = validateFairerResult(nextModel, assignments);
        if (issue) { setError(`The solver result failed a safety check: ${issue}`); return; }
        setModel(nextModel); setSuggestion(assignments);
        setResultNotes(message.result.notes ?? []);
        setConsultantFallbackCheck(message.result.debug?.consultantFallbackCheck);
      } else if (message.type === 'infeasible') setError(limit === 'none' ? 'No suggestion can meet the place totals and doctor-days together.' : 'No suggestion can meet the place totals, doctor-days and selected change limit together. Try a higher change limit.');
      else setError(message.message);
    };
    worker.onerror = event => { setRunning(false); worker.terminate(); workerRef.current = null; setError(event.message || 'The solver stopped unexpectedly.'); };
    const request: WorkerRequest = {
      problem: nextModel.problem, timeLimit: remainingTimeLimit, buildOptions: nextModel.buildOptions,
      ...(nextModel.consultantPlan.enabled ? { fairerStage: nextModel, afterTierReserve: { tier: 'fairness', fraction: 0.25 } } : {}),
    };
    worker.postMessage(request);
    saveSettings({ start, end, changeLimit: limit, maxDays });
  };
  const cancel = () => { workerRef.current?.terminate(); workerRef.current = null; setRunning(false); setProgress(undefined); };
  useEffect(() => () => workerRef.current?.terminate(), []);
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setProgress(current => current ? { ...current, elapsed: (Date.now() - solveStartedRef.current) / 1000 } : current), 300);
    return () => window.clearInterval(timer);
  }, [running]);
  const display = useMemo(() => model && suggestion ? makeFairerDisplay(ws, settings, model, suggestion) : undefined, [ws, settings, model, suggestion]);
  useEffect(() => {
    if (!suggestion) return;
    const before = () => {
      document.body.classList.add('fairer-printing');
      const root = document.querySelector<HTMLElement>('.fairer-print-root');
      if (root) fitFairerPrint(root);
    };
    const after = () => {
      document.body.classList.remove('fairer-printing');
      document.querySelectorAll<HTMLElement>('.fairer-print-week').forEach(sheet => sheet.style.removeProperty('zoom'));
    };
    window.addEventListener('beforeprint', before);
    window.addEventListener('afterprint', after);
    return () => { after(); window.removeEventListener('beforeprint', before); window.removeEventListener('afterprint', after); };
  }, [suggestion]);

  if (!loaded || !snapshot) return <section className="page-content"><Empty><h1>Fairer rota</h1><p>Import a rota first. This page makes a suggestion in memory and never changes the imported rota.</p><button onClick={() => go('import')}>Update from MediRota</button></Empty></section>;
  const rows = summary;
  const beforeRuns = model ? runStats(model.dayJobs, model.dayJobs, model) : undefined;
  const afterRuns = model && suggestion ? runStats(model.dayJobs, suggestion, model) : undefined;
  const runShare = (stats?: { qualifying: number; threePlus: number }) => stats?.qualifying ? `${Math.round(stats.threePlus / stats.qualifying * 100)}%` : '0%';
  const viewPerson = ws.role === 'coordinator' ? undefined : ws.me ? ws.profile.staff.find(person => person.id === ws.me) : undefined;
  const orderedGroups = settings.groups.flatMap(group => group.subGroups?.length ? group.subGroups.map(sub => ({ id: sub.id, name: `${group.name} · ${sub.name}`, groupId: group.id })) : [{ id: group.id, name: group.name, groupId: group.id }]);
  const changesPercent = model?.movable.length ? Math.round(movedCount / model.movable.length * 100) : 0;
  const viewerComparison = viewPerson ? sessionComparisonFor(viewPerson, ws.profile, settings, ws.sessionSubGroups ?? {}).comparisonId : undefined;
  const favouredHeadline = favouredRatioHeadline(settings, rows, viewerComparison);
  const longRange = dateList.length > 13 * 7;
  const resultDates = display?.dates ?? dateList;
  const weeks = fairerWeekOptions(resultDates);
  const currentWeek = weeks.includes(weekJump) ? weekJump : weeks[0] ?? '';
  const weekIndex = weeks.indexOf(currentWeek);
  const gridDates = currentWeek ? fairerWeekDates(currentWeek) : [];
  const changedWeeks = display ? fairerChangedWeeks(display, viewPerson?.id) : [];
  const gridDisplay = display ? { ...display, doctors: display.doctors.filter(person => { const staff = ws.profile.staff.find(item => item.id === person.id); return !staff?.locum || staff.regularLocum; }) } : undefined;
  const progressWeeks = Math.max(1, Math.ceil(dateList.length / 7));

  return <section className="fairer-page page-content">
    <header className="page-head"><div><p className="eyebrow">A rota suggestion</p><h1>Fairer rota</h1><p className="muted">Rota as of {latest ? new Date(latest).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown'}</p></div></header>
    <section className={`fairer-settings ${suggestion && !settingsEditOpen ? 'is-collapsed' : ''}`}>
      {fairerSettingsCollapsed(!!suggestion, settingsEditOpen) ? <div className="fairer-settings-summary"><span>{fairerSettingsLine(start, end, limit, fairerConsultantSetting(consultantFallbackCheck, limit === 'none' && keepSameConsultants && consistency.groupIds.length > 0))}</span><button type="button" onClick={() => setSettingsEditOpen(true)}>Edit</button></div> : <><div className="fairer-settings-heading"><h2>Suggestion settings</h2>{suggestion && <button type="button" onClick={() => setSettingsEditOpen(false)}>Done</button>}</div><div className="fairer-controls">
      <label>From <input type="date" value={start} min={imported.start} max={end} onChange={e => { const value = e.target.value as ISODate; setStart(value); saveSettings({ start: value }); }} /></label>
      <label>To <input type="date" value={end} min={start} max={imported.end} onChange={e => { const value = e.target.value as ISODate; setEnd(value); saveSettings({ end: value }); }} /></label>
      <fieldset className="fairer-limit"><legend>Change at most</legend><div className="fairer-limit-options">
        <label><input type="radio" name="fairer-change-limit" checked={limit !== 'none'} onChange={() => chooseLimit(lastLimitedPercent)} /> Percentage</label>
        {limit !== 'none' && <span className="fairer-limit-percent"><span className="range-control"><input aria-label="Change at most percent" type="range" min="0" max="100" step="1" value={limit} onChange={e => chooseLimit(Number(e.target.value))} /><input aria-label="Change at most percent number" type="number" min="0" max="100" value={limit} onChange={e => chooseLimit(Math.max(0, Math.min(100, Number(e.target.value))))} />%</span></span>}
        <label><input type="radio" name="fairer-change-limit" checked={limit === 'none'} onChange={() => chooseLimit('none')} /> No limit</label>
        {fairerChangeLimitHint(limit, estimate) && <small>{fairerChangeLimitHint(limit, estimate)}</small>}
      </div></fieldset>
      <fieldset className="fairer-segment"><legend>Days in a row at one place</legend>{(['none', 2, 3, 4] as const).map(value => <button key={value} type="button" className={maxDays === value ? 'selected' : ''} aria-pressed={maxDays === value} onClick={() => { setMaxDays(value); saveSettings({ maxDays: value }); }}>{value === 'none' ? 'No limit' : value}</button>)}<p className="fairer-control-help">Stops the suggestion putting someone at the same place more than this many days running.</p></fieldset>
    </div>
      <div className="fairer-consultant-controls"><p className="small muted">{consultantListState.kind === 'none' ? 'No consultant lists yet. They come from MediRota’s By activity pages.' : consultantListState.kind === 'configure' ? <>Consultant lists imported up to {consultantListState.date ? dateLabel(consultantListState.date) : 'an unknown date'}. To keep doctors with the same consultants, choose which session types in <button type="button" className="link-button" onClick={() => openSessions('same-consultants')}>Settings → Same consultants</button>.</> : consultantListState.kind === 'allocated' ? `Consultants allocated up to ${dateLabel(consultantListState.date)}` : 'No consultant lists match the selected session types.'}</p>{consistency.groupIds.length > 0 && hasConsultantLists && <SameConsultantsControl label={consistencyLabel} savedChoice={keepSameConsultants} changeLimit={limit} onChange={checked => { setKeepSameConsultants(checked); saveSettings({ keepSameConsultants: checked }); }} />}{allocationDate && end > allocationDate && <p className="small muted">Consultants are only known up to {dateLabel(allocationDate)}, so later weeks are not planned for consistency.</p>}</div>
      <div className="fairer-targets"><div><b>Shares from Sessions</b>{types.length ? types.map(type => <p key={type.id}>{fairerSharesLine(type, settings)}</p>) : <p>No day session types are set up.</p>}</div><button onClick={() => openSessions('ratios')}>Edit in Settings → Sessions</button></div>
      <div className="row fairer-actions">{running ? <><button onClick={cancel}>Cancel</button><span className="muted">{progress?.label ?? 'Starting'} · {progress?.elapsed.toFixed(1) ?? '0.0'}s</span></> : <button className="primary" onClick={startSolve} disabled={!dateList.length}>Make fairer rota</button>}</div>
      {longRange ? <p className="small muted">This can take up to 3 minutes.</p> : running && <p className="small muted">This can take up to 3 minutes.</p>}
      {running && <div className="progress" aria-label="Solver progress"><div style={{ width: `${fairerProgressPercent(progress?.elapsed ?? 0, progressWeeks)}%` }} /></div>}
      {error && <p className="quiet-warning" role="alert">{error}</p>}
      <details className="fairer-how"><summary>How this works</summary><p>Only day jobs at a single place can move. Nights, long days, on-calls, part shifts, extra shifts, locums, leave, training and zero days stay exactly as imported.</p><p>Nobody's working hours or days change, only where they work.</p><p>Working-time rules aren't checked for moved sessions.</p><p>This is a suggestion. It isn't saved and doesn't change your imported rota.</p></details>
      </>}
    </section>
    {model && suggestion && <div className="fairer-result"><section className="fairer-card fairer-summary-box"><strong>Suggestion, not the real rota</strong><h2>{limit === 'none' ? 'No limit · ' : ''}{movedCount} of {model.movable.length} sessions changed ({changesPercent}%)</h2>{favouredHeadline && <h3>{favouredHeadline}</h3>}<p className="muted fairer-summary-metrics">Weeks with 3+ days at one place {runShare(beforeRuns)} → {runShare(afterRuns)} · Longest run at one place {beforeRuns?.longest ?? 0} → {afterRuns?.longest ?? 0} days</p>
        <FairerResultNotes notes={resultNotes} fallbackCheck={consultantFallbackCheck} onTryAgain={startSolve} />
        {limitReachedNote(limit, movedCount, model.maxChanges) && <p className="quiet-note">Your {limit}% limit was reached.</p>}
      </section>
      <FairerRatiosTable rows={rows} types={types} groups={orderedGroups} viewerGroupId={viewerComparison} />
      {showFairerConsultantCard({ enabled: !!model?.consultantPlan.enabled, hasConsistency: consistency.groupIds.length > 0 && consistency.typeIds.length > 0, hasReport: !!consultantSummary, fallbackCheck: consultantFallbackCheck }) && consultantSummary && <ConsultantCard report={consultantSummary} workspace={ws} viewId={viewPerson?.id} />}
      {display && <div className="fairer-export-actions"><button type="button" onClick={() => downloadFairerCsv(display)}>Download spreadsheet (CSV)</button><button type="button" onClick={() => window.print()}>Print or save as PDF</button><p className="small muted">Exports are made on your computer. Nothing is uploaded.</p></div>}
      {!gridOpen ? <button className="secondary fairer-grid-open" type="button" onClick={() => { const initial = fairerGridInitialState(); setChangedOnly(initial.changedOnly); setWeekJump(weeks[0] ?? ''); setGridOpen(true); }}>Show suggested rota</button> : <>
        <div className="fairer-grid-head"><h2>Suggested rota</h2><label><input type="checkbox" checked={changedOnly} onChange={e => setChangedOnly(e.target.checked)} /> Changed cells only</label></div>
        <div className="fairer-week-controls"><button type="button" disabled={weekIndex <= 0} onClick={() => setWeekJump(weeks[weekIndex - 1]!)}>Previous week</button><label className="fairer-week-picker">Week <select value={currentWeek} onChange={event => setWeekJump(event.target.value)}>{weeks.map(week => <option key={week} value={week}>Week of {dateLabel(week)}</option>)}</select></label><button type="button" disabled={weekIndex >= weeks.length - 1} onClick={() => setWeekJump(weeks[weekIndex + 1]!)}>Next week</button>{viewPerson && <button type="button" disabled={!changedWeeks.length} onClick={() => setWeekJump(fairerNextChangeWeek(changedWeeks, currentWeek)!)}>{changedWeeks.length ? 'Jump to my changes' : 'No changes for you'}</button>}</div>
        {gridDisplay && <FairerGrid key={`${currentWeek}-${changedOnly}`} display={gridDisplay} dates={gridDates} changedOnly={changedOnly} viewerId={viewPerson?.id} groups={orderedGroups} />}
        <p className="overview-asof fairer-asof">Suggestion only · Imported rota remains unchanged.</p>
      </>}
      {gridDisplay && createPortal(<div className="fairer-print-root">{weeks.map((week, index) => <section className="fairer-print-week" key={week}>
        {index === 0 && <><div className="fairer-print-summary"><h1>Fairer rota: suggestion, not the real rota</h1><p>{dateLabel(resultDates[0]!)} to {dateLabel(resultDates.at(-1)!)} · {movedCount} of {model.movable.length} sessions changed ({changesPercent}%)</p><p>Weeks with 3+ days at one place {runShare(beforeRuns)} → {runShare(afterRuns)} · Longest run {beforeRuns?.longest ?? 0} → {afterRuns?.longest ?? 0} days</p>{favouredHeadline && <p>{favouredHeadline}</p>}<FairerResultNotes notes={resultNotes} fallbackCheck={consultantFallbackCheck} /></div><FairerRatiosTable rows={rows} types={types} groups={orderedGroups} viewerGroupId={viewerComparison} printing /></>}
        <h2>Week of {dateLabel(week)}</h2><FairerGrid display={gridDisplay} dates={fairerWeekDates(week)} changedOnly={false} viewerId={viewPerson?.id} groups={orderedGroups} printing />
      </section>)}</div>, document.body)}
    </div>}
  </section>;
}

/** Show the ST theatre consultants card when same consultants was accepted, including within the 3% allowance. Hide only on fallback. */
export function showFairerConsultantCard({ enabled, hasConsistency, hasReport, fallbackCheck }: { enabled: boolean; hasConsistency: boolean; hasReport: boolean; fallbackCheck?: string }): boolean {
  return enabled && hasConsistency && hasReport && !fallbackCheck;
}

export function FairerResultNotes({ notes, fallbackCheck, onTryAgain }: { notes: string[]; fallbackCheck?: string; onTryAgain?: () => void }) {
  return <>{notes.map(note => <p className="quiet-note" key={note}>{fairerDisplayNote(note)}{fallbackCheck === 'fairness-over-allowance' && onTryAgain && <button className="fairer-try-again" type="button" onClick={onTryAgain}>Try again</button>}</p>)}</>;
}

export function FairerConsultantOutcome({ notes, fallbackCheck, report, workspace, viewId, enabled, hasConsistency, onTryAgain }: {
  notes: string[]; fallbackCheck?: string; report?: ConsultantReport; workspace: ReturnType<typeof useWorkspace>; viewId?: string; enabled: boolean; hasConsistency: boolean; onTryAgain?: () => void;
}) {
  return <>
    <section className="fairer-card fairer-summary-box"><FairerResultNotes notes={notes} fallbackCheck={fallbackCheck} onTryAgain={onTryAgain} /></section>
    {showFairerConsultantCard({ enabled, hasConsistency, hasReport: !!report, fallbackCheck }) && report && <ConsultantCard report={report} workspace={workspace} viewId={viewId} />}
  </>;
}

export function FairerRatiosTable({ rows, types, groups, viewerGroupId, printing = false }: { rows: SummaryRow[]; types: { id: string; name: string }[]; groups: { id: string; name: string; groupId: string }[]; viewerGroupId?: string; printing?: boolean }) {
  const activeTypes = types.filter(type => rows.some(row => row.typeId === type.id && row.before > 0));
  const percent = (value: number, capacity: number) => `${capacity ? Math.round(value / capacity * 100) : 0}%`;
  const pct = (value: number, capacity: number) => capacity ? value / capacity * 100 : 0;
  const markFor = (row: SummaryRow) => fairerShareMark(pct(row.before, row.capacity), pct(row.after, row.capacity), pct(row.aim, row.capacity));
  const value = (row: SummaryRow) => { const mark = markFor(row); return <>{percent(row.before, row.capacity)} → {percent(row.after, row.capacity)}{mark && <> <span className="fairer-share-mark" aria-label={mark === '✓' ? 'closer to the aim' : 'further from the aim'}>{mark}</span></>}</>; };
  const aim = (typeId: string) => <small className="fairer-aim">Aim: {groups.flatMap(group => { const row = rows.find(item => item.typeId === typeId && item.groupId === group.id); return row ? [`${group.name} ${percent(row.aim, row.capacity)}`] : []; }).join(' · ')}</small>;
  return <section className="fairer-card fairer-ratios-card"><h2>Share of each place</h2>
    <div className="fairer-ratios-desktop"><div className="fairer-table-scroll"><table className="fairer-summary-table"><thead><tr><th>Session type</th>{groups.map(group => <th key={group.id}>{group.name}{group.id === viewerGroupId && <span className="fairer-you-tag">You</span>}</th>)}</tr></thead><tbody>{activeTypes.map(type => <tr key={type.id}><th scope="row">{type.name}{aim(type.id)}</th>{groups.map(group => { const row = rows.find(item => item.typeId === type.id && item.groupId === group.id); return <td key={group.id}>{row ? value(row) : '·'}</td>; })}</tr>)}</tbody></table></div></div>
    {!printing && <div className="fairer-ratios-mobile">{activeTypes.map(type => <article className="fairer-ratio-type" key={type.id}><h3>{type.name}</h3>{aim(type.id)}{groups.map(group => { const row = rows.find(item => item.typeId === type.id && item.groupId === group.id); return row ? <p key={group.id}><b>{group.name}{group.id === viewerGroupId && <span className="fairer-you-tag">You</span>}</b><span>{value(row)}</span></p> : null; })}</article>)}</div>}
    <p className="fairer-share-key">MediRota → suggestion. ✓ closer to the aim, ✗ further from it.</p>
    {!activeTypes.length && <p className="small muted">No movable day sessions in this range.</p>}
  </section>;
}

/** British English count label: "1 consultant", "2 consultants", "1 theatre day", "0 theatre days". */
export function fairerCountLabel(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function ConsultantCard({ report, workspace, viewId }: { report: ConsultantReport; workspace: ReturnType<typeof useWorkspace>; viewId?: string }) {
  const rows = [...report.rows].sort((a, b) => Number(b.staffId === viewId) - Number(a.staffId === viewId) || a.name.localeCompare(b.name));
  const withPairs = rows.some(row => row.pairedBefore !== undefined);
  const names = (items: { name: string; days: number }[]) => items.length ? items.map(item => `${item.name} ${item.days}`).join(' · ') : 'None';
  const alreadyMet = (matched: number, repeated: number) => matched ? `${Math.round(repeated / matched * 100)}%` : '0%';
  const theatreTotalBefore = rows.reduce((sum, row) => sum + row.theatreDays, 0);
  const theatreTotalAfter = rows.reduce((sum, row) => sum + row.theatreDaysAfter, 0);
  return <section className="fairer-card fairer-consultant-card"><h2>ST theatre consultants</h2>{rows.length ? <><div className="fairer-consultant-desktop"><div className="table-wrap"><table className="fairer-summary-table"><thead><tr><th>Doctor</th><th>Theatre days</th><th>Different consultants</th><th>Days with a consultant already met</th><th>Consultants</th>{withPairs && <th>Paired lists</th>}</tr></thead><tbody>{rows.map(row => <tr className={row.staffId === viewId ? 'is-viewer' : ''} key={row.staffId}><th scope="row">{row.name}{workspace.profile.staff.find(person => person.id === row.staffId)?.regularLocum && <span className="pill">Locum</span>}</th><td><span className="consultant-before">{row.theatreDays}</span> → {row.theatreDaysAfter}</td><td><span className="consultant-before">{row.differentBefore}</span> → {row.differentAfter}</td><td><span className="consultant-before">{alreadyMet(row.matchedDaysBefore, row.repeatBefore)}</span> → {alreadyMet(row.matchedDaysAfter, row.repeatAfter)}</td><td><div>{names(row.consultantsAfter)}</div><small className="consultant-before">Before: {names(row.consultantsBefore)}</small></td>{withPairs && <td>{row.pairedBefore !== undefined ? `${row.pairedBefore} → ${row.pairedAfter}` : '·'}</td>}</tr>)}</tbody><tfoot><tr><th>Total</th><td><span className="consultant-before">{theatreTotalBefore}</span> → {theatreTotalAfter}</td><td><span className="consultant-before">{report.averageBefore.toFixed(1)}</span> → {report.averageAfter.toFixed(1)} average</td><td><span className="consultant-before">{Math.round(report.repeatBefore)}%</span> → {Math.round(report.repeatAfter)}%</td><td></td>{withPairs && <td>·</td>}</tr></tfoot></table></div></div><div className="fairer-consultant-mobile">{rows.map(row => <article className={row.staffId === viewId ? 'is-viewer' : ''} key={row.staffId}><h3>{row.name}{workspace.profile.staff.find(person => person.id === row.staffId)?.regularLocum && <span className="pill">Locum</span>}</h3><p><span className="consultant-before">{row.theatreDays}</span> → {fairerCountLabel(row.theatreDaysAfter, 'theatre day', 'theatre days')} · {fairerCountLabel(row.differentAfter, 'consultant', 'consultants')} · {alreadyMet(row.matchedDaysAfter, row.repeatAfter)} already met</p><p>{names(row.consultantsAfter)}</p><p className="consultant-before">Before: {names(row.consultantsBefore)}</p></article>)}</div></> : <p className="small muted">No matched consultant lists in this range.</p>}{report.fallbackDays > 0 && <p className="small muted">{report.fallbackDays} theatre days had no matching consultant list and were left out.</p>}{rows.length > 0 && <p className="small muted">Doctors with a consultant 3+ times: {report.doctorsThreeBefore} → {report.doctorsThreeAfter}.</p>}</section>;
}

function estimateMovable(ws: ReturnType<typeof useWorkspace>, start: ISODate, end: ISODate): number {
  try { return prepareFairerModel(ws, start, end, 100, 'none').movable.length; } catch { return 0; }
}

/** Show the limit note only when a positive ceiling actually stopped further moves. */
export function limitReachedNote(limit: number | 'none', movedCount: number, maxChanges: number): boolean {
  return typeof limit === 'number' && limit > 0 && limit < 100 && maxChanges > 0 && movedCount >= maxChanges;
}

export function SameConsultantsControl({ label, savedChoice, changeLimit, onChange }: { label: string; savedChoice: boolean; changeLimit: number | 'none'; onChange: (checked: boolean) => void }) {
  const disabled = changeLimit !== 'none';
  return <div className="same-consultants-option">
    <label className={disabled ? 'is-disabled' : ''}><input type="checkbox" checked={!disabled && savedChoice} disabled={disabled} onChange={event => onChange(event.target.checked)} /> <span>{label}</span></label>
    {disabled && <p className="small muted">Same consultants needs No limit.</p>}
  </div>;
}
