import { useEffect, useMemo, useRef, useState } from 'react';
import { detectPatterns, type ReturnWindow, type SwapPlan, type SwapRequest, type SwapResult, type SwapSettings, type SwapUnit } from '../../engine/swaps';
import type { ISODate, Staff, Weekday } from '../../engine/types';
import { weekday } from '../../engine/calendar';
import { MultiSelect } from '../components/MultiSelect';
import { HoursAlertNotice } from '../components/HoursAlert';
import { SwapDateCalendar } from '../components/SwapDateCalendar';
import { Empty, formatDateLong, PageHead, WEEKDAY_NAMES } from '../components/ui';
import { update, useWorkspace, type SwapRecentSearch } from '../store';
import { annualLeaveInputs, appendSwapPlans, calendarColumns, chainSentences, completePlansFirst, staffingSummaryLine, swapPlanNotes, datesOutsideImports, doctorCountText, groupSwapPlans, hoursSuggestionText, inclusiveDates, latestImport, localISODate, partialCoverageTitle, planChainSize, planFilterCounts, planIdentity, swapGroupHeading, swapLimitMessages, swapOptionPeople, swapRequesterPeople, swapResultIsCurrent, swapSettingsFingerprint, unitDescription, weekendActivities, withDeclinedDoctor, type SwapFormInputs, type SwapPlanFilter, type SwapResultHides } from '../swapsView';
import type { SwapWorkerMessage, SwapWorkerRequest } from '../swaps.worker';
import { DEFAULT_SHARE_LIMIT, makeShareContent, renderDayJobSwapPng, renderSharePng, shareText } from '../swapShare';
import type { Page } from './types';
import { analyseLeaveCheck, leaveCheckDayLine } from '../leaveCheck';
import { defaultSessionsSettings } from '../sessions';
import { dayJobSwapText, findDayJobSwapOptions, type DayJobSwapResult } from '../dayJobSwaps';
import { advanceSwapWizard, initialSwapRequesterId, isColleagueSwapRequester, leaveNeedsNoSwap, leaveStep5SkipStartsSearch, showSwapSearchFormCard, swapWizardTitles } from '../swapWizard';

const SWAP_SEARCH_LIMIT_MS = 60_000;

function DateList({ value, onChange, label }: { value: ISODate[]; onChange: (dates: ISODate[]) => void; label: string }) {
  const [next, setNext] = useState('');
  const [rangeStart, setRangeStart] = useState('');
  const [rangeEnd, setRangeEnd] = useState('');
  const add = () => {
    if (!next || value.includes(next)) return;
    onChange([...value, next].sort());
    setNext('');
  };
  const addRange = () => {
    const dates = inclusiveDates(rangeStart, rangeEnd);
    if (!dates.length) return;
    onChange([...new Set([...value, ...dates])].sort());
    setRangeStart(''); setRangeEnd('');
  };
  return (
    <div className="field-block">
      <label className="field">{label}
        <span className="row swap-date-add"><input type="date" value={next} onChange={event => setNext(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} /><button type="button" onClick={add} disabled={!next}>Add</button></span>
      </label>
      <div className="row swap-date-range"><label className="field">First date<input type="date" value={rangeStart} onChange={event => setRangeStart(event.target.value)} /></label><label className="field">Last date<input type="date" min={rangeStart} value={rangeEnd} onChange={event => setRangeEnd(event.target.value)} /></label><button type="button" onClick={addRange} disabled={!rangeStart || !rangeEnd || rangeEnd < rangeStart}>Add range</button></div>
      {value.length > 0 && <div className="swap-date-list">{value.map(date => <span className="swap-date-pill" key={date}>{formatDateLong(date)} <button type="button" aria-label={`Remove ${formatDateLong(date)}`} onClick={() => onChange(value.filter(item => item !== date))}>×</button></span>)}</div>}
    </div>
  );
}

function doctorName(staff: Staff[], id: string): string {
  return staff.find(person => person.id === id)?.name ?? 'Unknown doctor';
}

function personSummary(staff: Staff[], ids: string[]): string {
  if (!ids.length) return 'Nobody';
  return ids.map(id => doctorName(staff, id)).join(', ');
}

export function displayRuledOutReason(reason: string): string {
  if (reason === "A valid swap exists but wasn't shown because of the plan limit.") return "There's a swap with this person, but it didn't make the first page. Use Find 50 more to see it.";
  const statusWords: Record<string, string> = { night: "They're on a night.", dayJob: "They're on a day job.", longDay: "They're on a long day.", partShift: "They're on a part shift.", 'not imported': "Their week isn't imported.", training: "They're on training.", leave: "They're on leave.", available: "They're marked as available.", notAvailable: "They're marked as not available.", blank: "Their week isn't imported." };
  let text = reason
    .replace('The doctor is not off (night).', "They're on a night.")
    .replace('The doctor is not off (dayJob).', "They're on a day job.")
    .replace('The doctor is not off (longDay).', "They're on a long day.")
    .replace('The doctor is not off (partShift).', "They're on a part shift.")
    .replace('The doctor is not off (not imported).', "Their week isn't imported.")
    .replace('Not on the rota on these dates', "Their week isn't imported")
    .replace('Marked available rather than off', 'Marked as available')
    .replace('Working ', 'On ')
    .replace(/\bdayJob\b/g, 'day job');
  text = text.replace(/The doctor is not off \(([^)]+)\)\./, (_match, status: string) => statusWords[status] ?? "They're working.");
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, value => new Date(`${value}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }));
}

function Calendar({ plan, staff, snapshot }: { plan: SwapPlan; staff: Staff[]; snapshot: NonNullable<ReturnType<typeof useWorkspace>['swapFinder']>['snapshot'] }) {
  const [after, setAfter] = useState(false);
  const people = [...new Set(plan.chains.flatMap(chain => chain.links.map(link => link.staffId)).concat(plan.movedShifts?.flatMap(move => [move.fromStaffId, move.toStaffId]) ?? []))];
  const changes = new Map<string, { added: string[]; removed: string[] }>();
  const dayDelta = new Map<string, number>();
  const addChange = (staffId: string, date: ISODate, side: 'added' | 'removed', label: string) => {
    const key = `${staffId}|${date}`, change = changes.get(key) ?? { added: [], removed: [] };
    change[side].push(label); changes.set(key, change);
  };
  for (const chain of plan.chains) for (let index = 0; index < chain.links.length; index++) {
    const link = chain.links[index], receiver = chain.links[(index + 1) % chain.links.length].staffId;
    const label = link.gives.activity || (link.gives.kind === 'nightBlock' ? 'Night' : link.gives.kind === 'longDay' ? 'Long day' : 'Day shift');
    for (const date of link.gives.dates) {
      addChange(link.staffId, date, 'removed', label);
      if (snapshot.days[receiver]?.[date]?.status === 'training') addChange(receiver, date, 'removed', 'Training');
      addChange(receiver, date, 'added', chain.sameDay && index === 1 ? `${label} (request as annual leave)` : label);
    }
    if (link.gives.kind !== 'nightBlock') { dayDelta.set(link.staffId, (dayDelta.get(link.staffId) ?? 0) - link.gives.dates.length); if (!chain.sameDay || index !== 1) dayDelta.set(receiver, (dayDelta.get(receiver) ?? 0) + link.gives.dates.length); }
  }
  for (const move of plan.movedShifts ?? []) {
    addChange(move.fromStaffId, move.date, 'removed', move.activity); addChange(move.toStaffId, move.date, 'added', move.activity);
    dayDelta.set(move.fromStaffId, (dayDelta.get(move.fromStaffId) ?? 0) - 1); dayDelta.set(move.toStaffId, (dayDelta.get(move.toStaffId) ?? 0) + 1);
  }
  const changedDates = [...new Set([...changes.keys()].map(key => key.split('|')[1]))];
  const columns = calendarColumns(changedDates);
  const name = (id: string) => staff.find(person => person.id === id)?.name ?? 'Unknown doctor';
  const beforeLabel = (staffId: string, date: ISODate) => {
    const day = snapshot.days[staffId]?.[date];
    if (!day || day.status === 'blank') return '';
    return day.activity || ({ zero: 'Zero Day', leave: 'Leave', training: 'Training', available: 'Available', notAvailable: 'Not available', night: 'Night', longDay: 'Long day', partShift: 'Part shift', dayJob: 'Day shift' } as Record<string, string>)[day.status] || day.status;
  };
  return <div className="swap-calendar"><div className="row swap-calendar-head"><div className="seg"><button className={!after ? 'on' : ''} onClick={() => setAfter(false)}>Before</button><button className={after ? 'on' : ''} onClick={() => setAfter(true)}>After</button></div>{people.map(id => <span className="swap-delta" key={id}>{name(id)} {dayDelta.get(id) ?? 0} day shifts</span>)}</div><div className="swap-calendar-scroll"><table><thead><tr><th>Doctor</th>{columns.map((date, index) => <th key={`${date}-${index}`} className={date !== '…' && weekday(date) >= 5 ? 'weekend' : ''}>{date === '…' ? date : formatDateLong(date)}</th>)}</tr></thead><tbody>{people.map(id => <tr key={id}><th>{name(id)}</th>{columns.map((date, index) => { if (date === '…') return <td key={`gap-${index}`}>…</td>; const change = changes.get(`${id}|${date}`); return <td key={date} className={weekday(date) >= 5 ? 'weekend' : ''}>{after && change ? <>{change.removed.map((label, i) => <span className="swap-shift removed" key={`r-${i}`}>{label}</span>)}{change.added.map((label, i) => <span className="swap-shift added" key={`a-${i}`}>{label}</span>)}</> : <span className="swap-shift">{beforeLabel(id, date)}</span>}</td>; })}</tr>)}</tbody></table></div></div>;
}

function PlanCard({ plan, index, staff, requesterId, snapshot, decline, findLongDay, noRulesWarning = false }: { plan: SwapPlan; index: number; staff: Staff[]; requesterId: string; snapshot: NonNullable<ReturnType<typeof useWorkspace>['swapFinder']>['snapshot']; decline: (staffId: string) => void; findLongDay: (date: ISODate) => void; noRulesWarning?: boolean }) {
  const [calendar, setCalendar] = useState(false);
  const contacts = [...new Set(plan.chains.flatMap(chain => chain.links.map(link => link.staffId)).filter(id => id !== requesterId))];
  const size = planChainSize(plan), type = size === 2 ? 'Direct' : `${size}-way`;
  const payWarning = plan.chains.some(chain => chain.payDifferent);
  const name = (id: string) => doctorName(staff, id);
  const warningCount = (plan.alerts?.length ?? 0) + plan.warnings.length;
  return (
    <article className="card swap-plan">
      <div className="swap-plan-head"><h3>{partialCoverageTitle(plan, requesterId) ?? `Option ${index + 1}`}</h3><div className="swap-tags"><span>{type}</span>{plan.blockLength && <span>Block of {plan.blockLength}</span>}<span>{noRulesWarning && !plan.alerts?.length ? 'Not checked: no rules set' : plan.alerts?.length ? `${plan.alerts.length} ${plan.alerts.length === 1 ? 'alert' : 'alerts'}` : 'No alerts'}</span>{(payWarning || plan.chains.some(chain => chain.sameDay)) && <span>Not like for like</span>}</div></div>
      <p><b>Ask:</b> {contacts.map(name).join(', ')}</p>
      {size === 2 ? <div className="swap-table-scroll"><table className="swap-moves"><thead><tr><th>You give</th><th>You take</th></tr></thead><tbody>{plan.chains.flatMap((chain, chainIndex) => { const give = chain.links[0].gives, take = chain.links[1].gives; const rows = Math.max(give.dates.length, take.dates.length); return Array.from({ length: rows }, (_, row) => <tr key={`${chainIndex}-${row}`}><td>{give.dates[row] ? `${formatDateLong(give.dates[row])} · ${give.activity}` : ''}</td><td>{take.dates[row] ? `${formatDateLong(take.dates[row])} · ${take.activity}` : ''}</td></tr>); })}</tbody></table></div> : <div className="swap-table-scroll"><table className="swap-moves"><thead><tr><th>Dates</th><th>Giver</th><th>Receiver</th></tr></thead><tbody>{plan.chains.flatMap((chain, chainIndex) => chain.links.map((link, step) => <tr key={`${chainIndex}-${step}`}><td>{link.gives.dates.map(formatDateLong).join(', ')}</td><td>{name(link.staffId)}</td><td>{name(chain.links[(step + 1) % chain.links.length].staffId)}</td></tr>))}</tbody></table></div>}
      {plan.chains.filter(chain => chain.sameDay).map((chain, i) => <p key={`same-day-${i}`}>{chainSentences(chain, staff, requesterId)[0]}</p>)}
      {swapPlanNotes(plan, name).map((note, noteIndex) => <p className="small" key={`${noteIndex}-${note}`}>{note}</p>)}
      {!!plan.movedShifts?.length && <section><h4>Also moves</h4><div className="swap-table-scroll"><table className="swap-moves"><thead><tr><th>Date</th><th>Activity</th><th>From</th><th>To</th></tr></thead><tbody>{plan.movedShifts.map((move, i) => <tr key={`${move.date}-${i}`}><td>{formatDateLong(move.date)}</td><td>{move.activity}</td><td>{name(move.fromStaffId)}</td><td>{name(move.toStaffId)}</td></tr>)}</tbody></table></div></section>}
      {!!plan.leaveRequests?.length && <section><h4>Request as annual leave</h4>{plan.leaveRequests.map(item => <p key={`${item.date}-${item.activity}`}>{formatDateLong(item.date)} · {item.activity}</p>)}</section>}
      {!!plan.toArrange?.length && <section><h4>Still to arrange</h4>{plan.toArrange.map(item => <div className="row" key={`${item.date}-${item.activity}`}><span>{formatDateLong(item.date)} · {item.activity}</span><button type="button" onClick={() => findLongDay(item.date)}>Find swaps for this long day</button></div>)}</section>}
      {plan.remaining.length > 0 && <div className="notice warn"><b>Still to arrange</b>{plan.remaining.map(unit => <div key={`${unit.staffId}-${unit.dates.join()}`}>{unitDescription(unit)}</div>)}</div>}
      {warningCount > 0 && <details className="swap-alerts"><summary>{warningCount} {warningCount === 1 ? 'alert' : 'alerts'}</summary>{plan.warnings.map((warning, warningIndex) => <div className="notice warn" key={`${warning.date}-${warning.doctors}-${warning.minimum}-${warningIndex}`}>This would leave {doctorCountText(warning.doctors)} against a minimum of {warning.minimum} on {formatDateLong(warning.date)}. This warning does not stop the swap.</div>)}{plan.alerts?.map((alert, alertIndex) => alert.hours ? <HoursAlertNotice alert={alert} doctorName={name(alert.staffId)} key={`${alert.staffId}-${alert.date}-${alertIndex}`} /> : <div className="notice warn" key={`${alert.staffId}-${alert.date}-${alertIndex}`}><b>{name(alert.staffId)}, {formatDateLong(alert.date)}:</b> {alert.message}. This warning does not stop the swap.{alert.suggestion && <div>{hoursSuggestionText(alert.suggestion)}</div>}</div>)}</details>}
      <button type="button" onClick={() => setCalendar(open => !open)}>{calendar ? 'Hide calendar' : 'Show calendar'}</button>
      {calendar && <Calendar plan={plan} staff={staff} snapshot={snapshot} />}
      {contacts.length > 0 && <div className="swap-decline"><span className="small muted">If somebody cannot help:</span>{contacts.map(id => <button type="button" key={id} onClick={() => decline(id)}>Leave out {doctorName(staff, id)} and search again</button>)}</div>}
    </article>
  );
}

function UnitList({ title, units }: { title: string; units: SwapUnit[] }) {
  if (!units.length) return null;
  return <section><h3>{title}</h3><ul className="plain-list">{units.map(unit => <li key={`${unit.staffId}-${unit.kind}-${unit.dates.join()}`}>{unitDescription(unit)}</li>)}</ul></section>;
}

function ShareResults({ plans, filter, hides, requesterId, staff, covered, existingShortages, extraShiftsToHandBack, importedAt, searchIncomplete }: { plans: SwapPlan[]; filter: SwapPlanFilter; hides: SwapResultHides; requesterId: string; staff: Staff[]; covered: SwapUnit[]; existingShortages: { date: ISODate; doctors: number; minimum: number }[]; extraShiftsToHandBack?: { date: ISODate; activity: string }[]; importedAt?: string; searchIncomplete?: boolean }) {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState<5 | 10 | 'all'>(DEFAULT_SHARE_LIMIT);
  const [message, setMessage] = useState('');
  const [imageBlob, setImageBlob] = useState<Blob>();
  const [imageUrl, setImageUrl] = useState('');
  const requesterName = doctorName(staff, requesterId);
  const nameFor = (id: string) => doctorName(staff, id);
  const input = { plans, filter, hides, requesterId, requesterName, nameFor, covered: covered.map(unit => ({ dates: unit.dates, activity: unit.activity, kind: unit.kind })), existingShortages, extraShiftsToHandBack, importedAt, limit, searchIncomplete };
  const content = useMemo(() => makeShareContent(input), [plans, filter, hides, requesterId, requesterName, staff, covered, existingShortages, extraShiftsToHandBack, importedAt, limit, searchIncomplete]);
  const text = shareText(content);
  useEffect(() => {
    if (!open) return;
    let active = true;
    let url = '';
    setImageBlob(undefined);
    setImageUrl('');
    void renderSharePng(content).then(blob => {
      if (!active) return;
      setImageBlob(blob);
      url = URL.createObjectURL(blob);
      setImageUrl(url);
    }).catch(() => { if (active) setImageUrl(''); });
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [open, content, text]);
  const copyImage = async () => {
    setMessage('');
    try {
      const blob = imageBlob ?? await renderSharePng(content);
      setImageBlob(blob);
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image clipboard is not available.');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setMessage('Image copied.');
    } catch { setMessage('Image could not be copied. Use Save image instead.'); }
  };
  const saveImage = async () => {
    const blob = imageBlob ?? await renderSharePng(content);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = 'swap-options.png'; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyText = async () => { try { if (!navigator.clipboard?.writeText) throw new Error('Text clipboard is not available.'); await navigator.clipboard.writeText(text); setMessage('Message copied.'); } catch { setMessage('Message could not be copied. Select and copy it from the preview.'); } };
  return (
    <section className="swap-share">
      <button type="button" onClick={() => setOpen(value => !value)}>{open ? 'Close share options' : 'Share results'}</button>
      {open && <div className="card swap-share-panel">
        <h3>Share results</h3>
        <div className="row swap-share-limit">
          <label className="field">How many options<select value={limit} onChange={event => setLimit(event.target.value === 'all' ? 'all' : Number(event.target.value) as 5 | 10)}><option value={5}>Top 5</option><option value={10}>Top 10</option><option value="all">All shown</option></select></label>
          {searchIncomplete && <p className="small muted swap-share-incomplete">Some options aren't loaded yet. Use Find 50 more to include them.</p>}
        </div>
        <div className="swap-share-preview">
          <h4>Image preview</h4>{imageUrl ? <img src={imageUrl} alt="Generated swap options share image" /> : <p className="small">Preparing image preview…</p>}
          <label className="field">WhatsApp message<textarea readOnly value={text} rows={12} /></label>
        </div>
        <div className="row"><button type="button" onClick={() => void copyImage()}>Copy image</button><button type="button" onClick={() => void saveImage()}>Save image</button><button type="button" onClick={() => void copyText()}>Copy text</button></div>
        {message && <p role="status" className="small">{message}</p>}
      </div>}
    </section>
  );
}

function DayJobShare({ result, date, requesterName }: { result: DayJobSwapResult; date: ISODate; requesterName: string }) {
  const [open, setOpen] = useState(false), [imageUrl, setImageUrl] = useState(''), [blob, setBlob] = useState<Blob>(), [message, setMessage] = useState('');
  const input = { date, requesterName, requesterPlace: result.requesterPlaceName ?? '', groups: result.groups };
  const text = dayJobSwapText({ date, requesterPlace: input.requesterPlace, groups: result.groups });
  useEffect(() => {
    if (!open) return;
    let active = true, url = '';
    void renderDayJobSwapPng(input).then(value => { if (!active) return; setBlob(value); url = URL.createObjectURL(value); setImageUrl(url); }).catch(() => setImageUrl(''));
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [open, date, requesterName, result]);
  const save = async () => { const image = blob ?? await renderDayJobSwapPng(input); const url = URL.createObjectURL(image); const link = document.createElement('a'); link.href = url; link.download = 'day-job-swap.png'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const copyImage = async () => { try { const image = blob ?? await renderDayJobSwapPng(input); setBlob(image); if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Image clipboard is not available.'); await navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]); setMessage('Image copied.'); } catch { setMessage('Image could not be copied. Use Save image instead.'); } };
  const copyText = async () => { try { await navigator.clipboard.writeText(text); setMessage('Message copied.'); } catch { setMessage('Message could not be copied. Select and copy it from the preview.'); } };
  if (!result.count || !result.requesterPlaceName) return null;
  return <section className="swap-share day-job-share"><button type="button" onClick={() => setOpen(value => !value)}>{open ? 'Close share options' : 'Share results'}</button>{open && <div className="card swap-share-panel"><h3>Share results</h3><div className="swap-share-preview"><h4>Image preview</h4>{imageUrl ? <img src={imageUrl} alt="Day job swap share image" /> : <p>Preparing image preview…</p>}<label className="field">WhatsApp message<textarea readOnly value={text} rows={6} /></label></div><div className="row"><button type="button" onClick={() => void copyImage()}>Copy image</button><button type="button" onClick={() => void save()}>Save image</button><button type="button" onClick={() => void copyText()}>Copy text</button></div>{message && <p role="status">{message}</p>}</div>}</section>;
}

function DayJobResults({ result, date, requesterName }: { result: DayJobSwapResult; date: ISODate; requesterName: string }) {
  const label = new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  return <section className="card swap-results day-job-results"><h2>Day-job swaps</h2>{result.requesterPlaceName && <p className="day-job-requester">{label}: {result.requesterPlaceName}</p>}{result.message ? <p>{result.message}</p> : <><p><b>{result.count} {result.count === 1 ? 'colleague' : 'colleagues'} on other day jobs on {label}</b></p>{result.groups.map(group => <section className="day-job-group" key={group.placeId}><h3>{group.placeName}</h3><ul>{group.people.map(person => <li key={person.staff.id}>{person.staff.name}{person.grade && ` (${person.grade})`}{person.consultants.length > 0 && <span className="small muted"> · with {person.consultants.join(', ')}</span>}</li>)}</ul></section>)}<DayJobShare result={result} date={date} requesterName={requesterName} /></>}</section>;
}

function Results({ result, staff, requesterId, snapshot, decline, findLongDay, loadMore, loading, go, hasChosenPeople }: { result: SwapResult; staff: Staff[]; requesterId: string; snapshot: NonNullable<ReturnType<typeof useWorkspace>['swapFinder']>['snapshot']; decline: (id: string) => void; findLongDay: (date: ISODate) => void; loadMore: (size: 2 | 3 | 4) => void; loading: boolean; go: (page: Page) => void; hasChosenPeople: boolean }) {
  const [filter, setFilter] = useState<SwapPlanFilter>('all');
  const [hides, setHides] = useState<SwapResultHides>({});
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  useEffect(() => { setFilter('all'); setHides({}); setExpandedGroups(new Set()); }, [result]);
  const counts = planFilterCounts(result.plans, hides);
  const hasChosen = hasChosenPeople;
  const chosenGroups = groupSwapPlans(result.plans, requesterId, filter, true, hides);
  const otherGroups = groupSwapPlans(result.plans, requesterId, filter, false, hides);
  const planGroups = hasChosen ? otherGroups : groupSwapPlans(result.plans, requesterId, filter, undefined, hides);
  const filters: { id: SwapPlanFilter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'ask1', label: 'Ask 1' }, { id: 'ask2', label: 'Ask 2' }, { id: 'ask3', label: 'Ask 3' }, { id: 'noAlerts', label: result.noRulesWarning ? 'Not checked' : 'No alerts' }, { id: 'blocks', label: 'Blocks' }];
  const renderGroups = (groups: ReturnType<typeof groupSwapPlans>) => groups.map(group => { const expanded = expandedGroups.has(group.key); const complete = completePlansFirst(group.options.map(option => option.plan)); const ordered = complete.map(plan => group.options.find(option => option.plan === plan)!); const shown = expanded ? ordered : ordered.slice(0, 1); return <section className="swap-person-group stack" key={group.key}><div className="card row swap-person-group-head"><b>{swapGroupHeading(group.people.map(id => doctorName(staff, id)), group.options.length)}</b>{group.options.length > 1 && <button type="button" onClick={() => setExpandedGroups(current => { const next = new Set(current); if (expanded) next.delete(group.key); else next.add(group.key); return next; })}>{expanded ? 'Show best only' : 'Show all'}</button>}</div>{shown.map(({ plan, index }) => <PlanCard key={planIdentity(plan)} plan={plan} index={index} staff={staff} requesterId={requesterId} snapshot={snapshot} decline={decline} findLongDay={findLongDay} noRulesWarning={result.noRulesWarning} />)}</section>; });
  const grouped = new Map<string, typeof result.ruledOut>();
  for (const row of result.ruledOut) grouped.set(row.group, [...(grouped.get(row.group) ?? []), row]);
  const groupLabels: Record<string, string> = { notOnRota: 'Not on rota', working: 'Working', leave: 'On leave', training: 'Training', excluded: 'Excluded', other: 'Other' };
  return (
    <div className="stack swap-results" aria-live="polite">
      <div className="card stack">
        <UnitList title="Shifts that need arranging" units={result.clashes} />
        {result.extraShiftsToHandBack.length > 0 && <section><h3>Extra shifts: hand back to medical staffing</h3><ul className="plain-list">{result.extraShiftsToHandBack.map(item => <li key={`${item.date}-${item.activity}`}>{item.activity} on {formatDateLong(item.date)}</li>)}</ul></section>}
        {result.sortByHand.length > 0 && <section><h3>Sort these part shifts by hand</h3><ul className="plain-list">{result.sortByHand.map(item => <li key={`${item.date}-${item.activity}`}>{item.activity} on {formatDateLong(item.date)}</li>)}</ul></section>}
        {result.requestAsLeave.length > 0 && <section><h3>Request as annual leave, no swap needed</h3><ul className="plain-list">{result.requestAsLeave.map(item => <li key={`${item.date}-${item.activity}`}>{item.activity} on {formatDateLong(item.date)}</li>)}</ul></section>}
        {staffingSummaryLine(result.leaveWarnings, result.existingShortages) && <details className="swap-staffing-summary"><summary>{staffingSummaryLine(result.leaveWarnings, result.existingShortages)}</summary>{result.leaveWarnings.map(warning => <p key={warning.date}>{formatDateLong(warning.date)}: {warning.doctors} doctors working, minimum {warning.minimum}</p>)}{result.existingShortages.map(shortage => <p key={`existing-shortage-${shortage.date}`}>{formatDateLong(shortage.date)}: already short, {shortage.doctors} doctors working, minimum {shortage.minimum}</p>)}</details>}
      </div>
      {result.noRulesWarning && <div className="notice warn">No working-time rules are set, so these options haven't been checked for rest or hours. <button type="button" className="link-button" onClick={() => go('rules')}>Settings → Rules</button></div>}
      {swapLimitMessages(result.limits, true).map(message => <div className="notice warn" key={message}>{message}</div>)}
      {result.plans.length === 0
        ? <Empty><h2>No swap options found</h2><p>The finder could not make a valid chain for these dates. Open the reasons below to see why each doctor was ruled out.</p></Empty>
        : <div className="stack"><div className="row swap-results-top"><ShareResults plans={result.plans} filter={filter} hides={hides} requesterId={requesterId} staff={staff} covered={result.clashes} existingShortages={result.existingShortages} extraShiftsToHandBack={result.extraShiftsToHandBack} importedAt={latestImport(snapshot)} searchIncomplete={!!(result.morePlanSizes?.length || result.limits?.length || result.truncated)} /><div className="swap-results-controls"><div className="swap-filters">{filters.map(item => <button type="button" className={filter === item.id ? 'on' : ''} key={item.id} onClick={() => setFilter(item.id)}>{item.label} <span>{counts[item.id]}</span></button>)}</div><div className="swap-hide-switches"><label><input type="checkbox" checked={!!hides.hideSameDay} onChange={event => setHides(current => ({ ...current, hideSameDay: event.target.checked }))} /> Hide NWD swaps</label><label><input type="checkbox" checked={!!hides.hideMissedTraining} onChange={event => setHides(current => ({ ...current, hideMissedTraining: event.target.checked }))} /> Hide missed training</label></div></div></div><h2>{counts[filter]} {counts[filter] === 1 ? 'option' : 'options'}</h2>{hasChosen && chosenGroups.length > 0 && <section className="stack"><h2>Your chosen people</h2>{renderGroups(chosenGroups)}</section>}{hasChosen && planGroups.length > 0 && <h2>Everyone else</h2>}{renderGroups(planGroups)}{!!result.morePlanSizes?.length && <div className="row swap-more-plans">{result.morePlanSizes.map(size => <button type="button" disabled={loading} key={size} onClick={() => loadMore(size)}>Find 50 more {size === 2 ? 'direct' : `${size}-way`}</button>)}</div>}</div>}
      <details className="card swap-reasons" open={result.plans.length === 0 || undefined}><summary>Why other doctors were ruled out</summary>{result.ruledOut.length === 0 ? <p className="muted">No further reasons were recorded.</p> : [...grouped].map(([group, rows]) => <section key={group}><h3>{groupLabels[group] ?? group} ({rows.length})</h3>{rows.map((item, index) => <p key={`${item.staffId}-${item.unit.dates.join()}-${index}`}><b>{doctorName(staff, item.staffId)}</b>: {displayRuledOutReason(item.reason)}</p>)}</section>)}{!!result.notCheckedYet?.length && <section><h3>Not checked yet ({result.notCheckedYet.length})</h3>{[...new Set(result.notCheckedYet.map(item => item.staffId))].map(id => <p key={id}><b>{doctorName(staff, id)}</b>: not checked yet</p>)}</section>}</details>
    </div>
  );
}

export function SwapSettingsPanel({ settings, staff, snapshot, save }: { settings: SwapSettings; staff: Staff[]; snapshot: NonNullable<ReturnType<typeof useWorkspace>['swapFinder']>['snapshot']; save: (mutate: (settings: SwapSettings) => void, override?: { staffId: string; field: 'excludeFromSwaps' | 'regularDaysOff' }) => void }) {
  const activities = weekendActivities(snapshot, settings.bankHolidays);
  const flags = detectPatterns(snapshot);
  const undecided = flags.filter(flag => flag.kind === 'regularDaysOff'
    ? flag.weekdays.some(day => !(settings.regularDaysOff[flag.staffId] ?? []).includes(day))
    : !settings.excluded.some(entry => entry.staffId === flag.staffId));
  const [excludeId, setExcludeId] = useState(staff[0]?.id ?? '');
  const [excludeUntil, setExcludeUntil] = useState('');
  const toggleActivity = (activity: string) => save(draft => { draft.weekendDayActivities = draft.weekendDayActivities.includes(activity) ? draft.weekendDayActivities.filter(item => item !== activity) : [...draft.weekendDayActivities, activity]; });
  const addExcluded = (staffId: string, until?: ISODate) => save(draft => {
    draft.excluded = [...draft.excluded.filter(entry => entry.staffId !== staffId), { staffId, ...(until ? { until } : {}) }];
  }, { staffId, field: 'excludeFromSwaps' });
  return (
    <div className="card stack swap-settings">
        <section><h3>Weekend and bank holiday day shifts</h3><p className="small muted">Choose which activities can be swapped on these days.</p>{activities.length === 0 ? <p className="muted">No suitable activities were found in the imported rota.</p> : <div className="check-grid">{activities.map(activity => <label key={activity}><input type="checkbox" checked={settings.weekendDayActivities.includes(activity)} onChange={() => toggleActivity(activity)} /> {activity}</label>)}</div>}</section>
        <label className="field">Similar-hours tolerance<input type="number" min="0" step="0.5" value={settings.hoursTolerance} onChange={event => save(draft => { draft.hoursTolerance = Math.max(0, Number(event.target.value)); })} /><span className="small muted">hours</span></label>
        <section><h3>Rest around night blocks</h3><p className="small muted">The nearest day on each side is always mandatory. Additional days are recommended.</p><div className="grid-2"><label className="field">Days before<input type="number" min="1" max="7" value={settings.nightRestDaysBefore ?? 2} onChange={event => save(draft => { draft.nightRestDaysBefore = Math.max(1, Math.floor(Number(event.target.value))); })} /></label><label className="field">Days after<select value={settings.nightRestDaysAfter ?? ''} onChange={event => save(draft => { draft.nightRestDaysAfter = event.target.value ? Number(event.target.value) : undefined; })}><option value="">Automatic: 2, or 3 after 4+ nights</option>{[1, 2, 3, 4, 5, 6, 7].map(days => <option key={days} value={days}>{days}</option>)}</select></label></div></section>
        <section><h3>Minimum doctors physically working</h3><div className="swap-minimums">{WEEKDAY_NAMES.map((day, index) => <label className="field" key={day}>{day}<input type="number" min="0" placeholder="No minimum" value={settings.minDoctors[index] || ''} onChange={event => save(draft => { draft.minDoctors[index] = Math.max(0, Number(event.target.value) || 0); })} /></label>)}<label className="field">Bank holiday<input type="number" min="0" placeholder="No minimum" value={settings.minDoctorsBankHoliday || ''} onChange={event => save(draft => { draft.minDoctorsBankHoliday = Math.max(0, Number(event.target.value) || 0); })} /></label></div></section>
        <DateList label="Bank holiday dates" value={settings.bankHolidays} onChange={dates => save(draft => { draft.bankHolidays = dates; })} />
        <section><h3>Pattern suggestions to review</h3>{undecided.length === 0 ? <p className="muted">No undecided patterns.</p> : undecided.map((flag, index) => <div className="decide-row" key={`${flag.staffId}-${flag.kind}-${index}`}><span><b>{doctorName(staff, flag.staffId)}</b><br /><span className="small muted">{flag.kind === 'regularDaysOff' ? `Usually has ${flag.weekdays.map(day => WEEKDAY_NAMES[day]).join(', ')} off` : `Appears to work only ${flag.weekdays.map(day => WEEKDAY_NAMES[day]).join(', ')}`} across {flag.weeksInPost} weeks</span></span>{flag.kind === 'regularDaysOff' ? <button type="button" onClick={() => save(draft => { draft.regularDaysOff[flag.staffId] = [...new Set([...(draft.regularDaysOff[flag.staffId] ?? []), ...flag.weekdays])] as Weekday[]; }, { staffId: flag.staffId, field: 'regularDaysOff' })}>Confirm days off</button> : <button type="button" onClick={() => addExcluded(flag.staffId)}>Exclude doctor</button>}</div>)}</section>
        <section><h3>Confirmed regular days off</h3>{Object.entries(settings.regularDaysOff).filter(([, days]) => days.length).length === 0 ? <p className="muted">None confirmed.</p> : Object.entries(settings.regularDaysOff).filter(([, days]) => days.length).map(([staffId, days]) => <div className="decide-row" key={staffId}><span><b>{doctorName(staff, staffId)}</b>: {days.map(day => WEEKDAY_NAMES[day]).join(', ')}</span><button type="button" onClick={() => save(draft => { delete draft.regularDaysOff[staffId]; }, { staffId, field: 'regularDaysOff' })}>Remove</button></div>)}</section>
        <section><h3>Excluded doctors</h3>{settings.excluded.length === 0 ? <p className="muted">Nobody is excluded.</p> : settings.excluded.map(entry => <div className="decide-row" key={entry.staffId}><span><b>{doctorName(staff, entry.staffId)}</b>{entry.until ? ` until ${formatDateLong(entry.until)}` : ', no end date'}</span><button type="button" onClick={() => save(draft => { draft.excluded = draft.excluded.filter(item => item.staffId !== entry.staffId); }, { staffId: entry.staffId, field: 'excludeFromSwaps' })}>Remove</button></div>)}
          <div className="row swap-add-exclusion"><label className="field">Doctor<select value={excludeId} onChange={event => setExcludeId(event.target.value)}>{staff.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label><label className="field">Optional end date<input type="date" value={excludeUntil} onChange={event => setExcludeUntil(event.target.value)} /></label><button type="button" onClick={() => { if (excludeId) addExcluded(excludeId, excludeUntil || undefined); }}>Exclude doctor</button></div>
        </section>
    </div>
  );
}

export function FindSwaps({ go }: { go: (page: Page) => void }) {
  const ws = useWorkspace();
  const data = ws.swapFinder;
  const staff = ws.profile.staff;
  const visibleStaff = swapRequesterPeople(staff);
  const initialStaff = initialSwapRequesterId(ws.role, ws.me, visibleStaff.map(person => person.id));
  const [staffId, setStaffId] = useState(initialStaff);
  const [searchType, setSearchType] = useState<'leave' | 'dayJob'>('leave');
  const [wizardStep, setWizardStep] = useState(1);
  const firstImportedDate = Object.keys(data?.snapshot.importedAt ?? {}).sort()[0] ?? localISODate();
  const [dayJobDate, setDayJobDate] = useState<ISODate>(firstImportedDate);
  const [doctorText, setDoctorText] = useState(() => initialStaff ? doctorName(visibleStaff, initialStaff) : '');
  const [searchForSomeoneElse, setSearchForSomeoneElse] = useState(false);
  const [leaveDates, setLeaveDates] = useState<ISODate[]>([]);
  const [cantWorkDates, setCantWorkDates] = useState<ISODate[]>([]);
  const [excluded, setExcluded] = useState<string[]>([]);
  const [includeNormalDays, setIncludeNormalDays] = useState(data?.settings.includeNormalDays ?? false);
  const [askMode, setAskMode] = useState<'everyone' | 'only' | 'prefer'>('everyone');
  const [askStaffIds, setAskStaffIds] = useState<string[]>([]);
  const [returnPattern, setReturnPattern] = useState(data?.settings.returnPattern ?? 'consecutive');
  const [returnDayType, setReturnDayType] = useState(data?.settings.returnDayType ?? 'noPreference');
  const [returnWindow, setReturnWindow] = useState<ReturnWindow>(data?.settings.returnWindow ?? { kind: 'any' });
  const [noAlertsOnly, setNoAlertsOnly] = useState(data?.settings.noAlertsOnly ?? false);
  const [maxChain, setMaxChain] = useState(data?.settings.maxChain ?? 4);
  const [result, setResult] = useState<{ value: SwapResult; inputs: SwapFormInputs; settingsFingerprint: string; planLimits: Partial<Record<2 | 3 | 4, number>> }>();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [seconds, setSeconds] = useState(0);
  const worker = useRef<Worker | undefined>(undefined);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => { worker.current?.terminate(); if (timer.current) window.clearInterval(timer.current); }, []);

  const currentInputs: SwapFormInputs = { staffId, leaveDates, leaveType: 'annual', cantWorkDates, excludedStaffIds: excluded, includeNormalDays, askMode, askStaffIds, returnPattern, returnDayType, returnWindow, noAlertsOnly, maxChain };
  const currentSettingsFingerprint = data ? swapSettingsFingerprint(data.settings) : '';
  const resultIsCurrent = result && swapResultIsCurrent(result.inputs, result.settingsFingerprint, currentInputs, currentSettingsFingerprint);
  const visibleResult = resultIsCurrent ? result : undefined;
  useEffect(() => { if (result && !resultIsCurrent) setResult(undefined); }, [staffId, leaveDates, cantWorkDates, excluded, includeNormalDays, askMode, askStaffIds, returnPattern, returnDayType, returnWindow, noAlertsOnly, maxChain, currentSettingsFingerprint, result, resultIsCurrent]);
  const today = localISODate();
  const outside = useMemo(() => data ? datesOutsideImports(data.snapshot, leaveDates) : [], [data, leaveDates]);
  const leaveCheck = useMemo(() => data ? analyseLeaveCheck(ws.profile, data.snapshot, data.settings, staff, ws.sessions ?? defaultSessionsSettings(ws.profile), staffId, leaveDates, includeNormalDays, today) : undefined, [data, staffId, leaveDates, includeNormalDays, today, ws.profile, ws.sessions, staff]);
  const dayJobResult = useMemo(() => data ? findDayJobSwapOptions({ profile: ws.profile, snapshot: data.snapshot, sessions: ws.sessions ?? defaultSessionsSettings(ws.profile), settings: data.settings, consultantLists: ws.consultantLists, requesterId: staffId, date: dayJobDate, viewerId: ws.me }) : undefined, [data, ws.profile, ws.sessions, ws.consultantLists, staffId, dayJobDate, ws.me]);
  const runSearch = (searchInputs: SwapFormInputs = currentInputs, planLimits: Partial<Record<2 | 3 | 4, number>> = {}, appendFrom?: typeof result, appendSize?: 2 | 3 | 4, keepLooking = false) => {
    if (!data || !searchInputs.staffId || !searchInputs.leaveDates.length) return;
    const requestInputs: SwapFormInputs = annualLeaveInputs(structuredClone(searchInputs));
    const requestSettingsFingerprint = swapSettingsFingerprint(data.settings);
    worker.current?.terminate();
    if (timer.current) window.clearInterval(timer.current);
    setError(''); if (!appendFrom && !keepLooking) setResult(undefined); setRunning(true); setProgress(appendFrom ? 'Finding 50 more options' : 'Starting the search'); setSeconds(0);
    const started = Date.now();
    timer.current = window.setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    const nextWorker = new Worker(new URL('../swaps.worker.ts', import.meta.url), { type: 'module' });
    worker.current = nextWorker;
    nextWorker.onmessage = (event: MessageEvent<SwapWorkerMessage>) => {
      if (event.data.type === 'progress') {
        setProgress(event.data.message);
        if (event.data.partialResult) setResult({ value: event.data.partialResult, inputs: requestInputs, settingsFingerprint: requestSettingsFingerprint, planLimits });
      }
      if (event.data.type === 'done') {
        const value = appendFrom ? { ...event.data.result, plans: appendSwapPlans(appendFrom.value.plans, event.data.result.plans, appendSize) } : event.data.result;
        setResult({ value, inputs: requestInputs, settingsFingerprint: requestSettingsFingerprint, planLimits }); setRunning(false); setWizardStep(searchType === 'dayJob' ? 3 : 6); nextWorker.terminate(); if (timer.current) window.clearInterval(timer.current);
        if (!appendFrom) update(draft => {
          if (!draft.swapFinder) return;
          const saved = requestInputs as SwapRecentSearch;
          const key = JSON.stringify(saved);
          draft.swapFinder.recentSearches = [saved, ...(draft.swapFinder.recentSearches ?? []).filter(item => JSON.stringify(item) !== key)].slice(0, 10);
        });
      }
      if (event.data.type === 'error') { setError(event.data.message); setRunning(false); nextWorker.terminate(); if (timer.current) window.clearInterval(timer.current); }
    };
    nextWorker.onerror = event => { setError(event.message || 'The search could not be completed.'); setRunning(false); nextWorker.terminate(); if (timer.current) window.clearInterval(timer.current); };
    const request: SwapRequest = { staffId: requestInputs.staffId, leaveDates: requestInputs.leaveDates, leaveType: 'annual', cantWorkDates: requestInputs.cantWorkDates, excludeStaffIds: requestInputs.excludedStaffIds, includeNormalDays: requestInputs.includeNormalDays, today: localISODate(), planLimits, returnPattern: requestInputs.returnPattern, returnDayType: requestInputs.returnDayType, returnWindow: requestInputs.returnWindow, noAlertsOnly: requestInputs.noAlertsOnly, askMode: requestInputs.askMode, askStaffIds: requestInputs.askStaffIds, deadlineMs: appendFrom ? 180_000 : keepLooking ? 180_000 : SWAP_SEARCH_LIMIT_MS };
    const payload: SwapWorkerRequest = { profile: ws.profile, snapshot: data.snapshot, settings: { ...data.settings, maxChain: requestInputs.maxChain ?? data.settings.maxChain }, request };
    nextWorker.postMessage(payload);
  };
  const decline = (id: string, resultInputs: SwapFormInputs) => {
    const next = withDeclinedDoctor(resultInputs, id);
    setStaffId(next.staffId); setDoctorText(doctorName(visibleStaff, next.staffId)); setLeaveDates(next.leaveDates); setCantWorkDates(next.cantWorkDates); setExcluded(next.excludedStaffIds); setIncludeNormalDays(next.includeNormalDays);
    runSearch(next);
  };
  const findLongDay = (date: ISODate, resultInputs: SwapFormInputs) => {
    const next = { ...resultInputs, leaveDates: [date] };
    setStaffId(next.staffId); setDoctorText(doctorName(visibleStaff, next.staffId)); setLeaveDates(next.leaveDates); setCantWorkDates(next.cantWorkDates); setExcluded(next.excludedStaffIds); setIncludeNormalDays(next.includeNormalDays); setWizardStep(6);
    runSearch(next);
  };
  const loadMore = (size: 2 | 3 | 4) => {
    if (!visibleResult) return;
    const planLimits = { ...visibleResult.planLimits, [size]: (visibleResult.planLimits[size] ?? (size === 2 ? 50 : 10)) + 50 };
    runSearch(visibleResult.inputs, planLimits, visibleResult, size);
  };
  const saveSettings = (mutate: (settings: SwapSettings) => void) => {
    worker.current?.terminate(); worker.current = undefined;
    if (timer.current) window.clearInterval(timer.current);
    timer.current = undefined;
    setRunning(false); setProgress(''); setResult(undefined);
    update(draft => { if (draft.swapFinder) mutate(draft.swapFinder.settings); });
  };
  const changeDoctor = (id: string) => {
    setStaffId(id); setDoctorText(doctorName(staff, id)); setAskStaffIds([]);
    setSearchForSomeoneElse(isColleagueSwapRequester(ws.role, ws.me, id));
  }
  const applyInputs = (inputs: SwapFormInputs) => {
    const annual = annualLeaveInputs(inputs);
    setStaffId(annual.staffId); setDoctorText(doctorName(staff, annual.staffId)); setLeaveDates(annual.leaveDates);
    setCantWorkDates(annual.cantWorkDates); setExcluded(annual.excludedStaffIds); setIncludeNormalDays(annual.includeNormalDays);
    setAskMode(annual.askMode ?? 'everyone'); setAskStaffIds(annual.askStaffIds ?? []); setReturnPattern(annual.returnPattern ?? 'consecutive');
    setReturnDayType(annual.returnDayType ?? 'noPreference'); setReturnWindow(annual.returnWindow ?? { kind: 'any' });
    setNoAlertsOnly(annual.noAlertsOnly ?? false); setMaxChain(annual.maxChain ?? data?.settings.maxChain ?? 4);
  };
  const rerunRecent = (recent: SwapRecentSearch) => { applyInputs(recent); setSearchForSomeoneElse(isColleagueSwapRequester(ws.role, ws.me, recent.staffId)); setSearchType('leave'); setWizardStep(2); setResult(undefined); };

  const noSwapNeeded = leaveNeedsNoSwap(leaveCheck);
  const stepTitles = swapWizardTitles(searchType);
  const moveStep = (next: number) => setWizardStep(Math.max(1, Math.min(stepTitles.length, next)));

  if (!data) return <><PageHead title="Find swaps">Find possible swaps from an imported MediRota rota.</PageHead><Empty><h2>Import a rota first</h2><p>The swap finder needs an imported MediRota rota before it can search.</p><button type="button" className="primary" onClick={() => go('import')}>Import from MediRota</button></Empty></>;
  const imported = latestImport(data.snapshot);
  return (
    <>
      <PageHead title="Find swaps">Find options to discuss without changing the rota.</PageHead>
      <section className="setup-wizard-card swap-wizard" aria-labelledby="swap-wizard-title">
      <p className="eyebrow">Find swaps</p>
      <div className="setup-wizard-progress"><span>Step {wizardStep} of {stepTitles.length}</span>{wizardStep > 1 && <span>{stepTitles[wizardStep - 1]}</span>}</div>
      <h1 id="swap-wizard-title">{stepTitles[wizardStep - 1]}</h1>
      {wizardStep === 1 && <div className="day-job-search-type"><div className="seg" aria-label="What do you need?"><button type="button" className={searchType === 'leave' ? 'on' : ''} onClick={() => { setSearchType('leave'); setWizardStep(1); }}>Cover my leave</button><button type="button" className={searchType === 'dayJob' ? 'on' : ''} onClick={() => { setSearchType('dayJob'); setWizardStep(1); }}>Swap my day job</button></div></div>}
      {!data.snapshot.extrasTagged && <p className="quiet-note">Extra shifts aren’t marked in this rota yet. Update from MediRota to mark them.</p>}
      {(wizardStep === 1 || wizardStep === 2) && <div className="notice swap-import-date"><b>Rota imported:</b> {imported ? new Date(imported).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short' }) : 'import date unavailable'}</div>}
      {searchType === 'dayJob' ? (showSwapSearchFormCard('dayJob', wizardStep, false) && <div className="card stack swap-search-form day-job-search-form">
        {wizardStep === 1 && <>{ws.role !== 'coordinator' && staffId && !searchForSomeoneElse ? <p>For you: {doctorName(staff, staffId)} <button type="button" className="link-button small" onClick={() => setSearchForSomeoneElse(true)}>Search for someone else</button></p> : <label className="field">{ws.role === 'coordinator' ? 'Doctor' : 'Who is this for?'}<input list="swap-doctors-day-job" value={doctorText} placeholder={ws.role === 'coordinator' ? 'Choose a doctor' : 'Who is this for?'} onChange={event => { const text = event.target.value; setDoctorText(text); const person = swapRequesterPeople(staff).find(item => item.name.toLocaleLowerCase() === text.toLocaleLowerCase()); if (person && person.id !== staffId) changeDoctor(person.id); else if (!text) setStaffId(''); }} /></label>}
        <datalist id="swap-doctors-day-job">{swapRequesterPeople(staff).map(person => <option key={person.id} value={person.name} />)}</datalist>
        </>}
        {wizardStep === 2 && <><p>Choose the day job you want to swap.</p>{dayJobResult?.requesterPlaceName && <p className="day-job-requester">{new Date(`${dayJobDate}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}: {dayJobResult.requesterPlaceName}</p>}
        <SwapDateCalendar snapshot={data.snapshot} staffId={staffId} leaveDates={[]} cantWorkDates={[]} onLeaveDates={() => undefined} onCantWorkDates={() => undefined} selectionMode="single" selectedDate={dayJobDate} onSelectedDateChange={setDayJobDate} />
        </>}
      </div>) : <>
      {showSwapSearchFormCard('leave', wizardStep, running, error) && <div className="card stack swap-search-form">
        {wizardStep === 1 && <>{ws.role !== 'coordinator' && staffId && !searchForSomeoneElse ? <p>For you: {doctorName(staff, staffId)} <button type="button" className="link-button small" onClick={() => setSearchForSomeoneElse(true)}>Search for someone else</button></p> : <label className="field">{ws.role === 'coordinator' ? 'Doctor' : 'Who is this for?'}<input list="swap-doctors" value={doctorText} placeholder={ws.role === 'coordinator' ? 'Choose a doctor' : 'Who is this for?'} onChange={event => { const text = event.target.value; setDoctorText(text); const person = swapRequesterPeople(staff).find(item => item.name.toLocaleLowerCase() === text.toLocaleLowerCase()); if (person && person.id !== staffId) changeDoctor(person.id); else if (!text) setStaffId(''); }} /></label>}
        <datalist id="swap-doctors">{swapRequesterPeople(staff).map(person => <option key={person.id} value={person.name} />)}</datalist>
        </>}
        {wizardStep === 4 && <section className="field-block"><div className="seg swap-ask-mode" aria-label="Who would you ask?"><button type="button" className={askMode === 'everyone' ? 'on' : ''} onClick={() => setAskMode('everyone')}>Everyone</button><button type="button" className={askMode === 'only' ? 'on' : ''} onClick={() => setAskMode('only')}>Only these people</button><button type="button" className={askMode === 'prefer' ? 'on' : ''} onClick={() => setAskMode('prefer')}>These people first, then everyone</button></div>{askMode !== 'everyone' && <MultiSelect label="People to ask" summary={askStaffIds.length ? personSummary(staff, askStaffIds.filter(id => swapOptionPeople(staff, staffId).some(person => person.id === id))) : 'Choose people'} clearLabel="Nobody chosen" onClear={() => setAskStaffIds([])} sections={[{ title: 'Doctors', options: swapOptionPeople(staff, staffId).map(person => ({ value: person.id, label: person.name })), value: askStaffIds.filter(id => swapOptionPeople(staff, staffId).some(person => person.id === id)), onChange: setAskStaffIds }]} />}</section>}
        {(wizardStep === 2 || wizardStep === 3) && <><p>{wizardStep === 2 ? 'Pick the days you need off.' : 'Pick any days you cannot work in return.'}</p><SwapDateCalendar snapshot={data.snapshot} staffId={staffId} leaveDates={leaveDates} cantWorkDates={cantWorkDates} onLeaveDates={setLeaveDates} onCantWorkDates={setCantWorkDates} forcedMode={wizardStep === 2 ? 'leave' : 'cantWork'} />
        {wizardStep === 2 && leaveCheck && <section className="leave-check" aria-label="Leave check">{leaveCheck.days.flatMap(row => row.dates.map(date => <p key={date}>{leaveCheckDayLine(date, row.activity, row.outcome, data.snapshot.days[staffId]?.[date]?.status, datesOutsideImports(data.snapshot, [date]).length > 0)}</p>))}</section>}</>}
      {wizardStep === 5 && <div className="stack">
          <label className="field">Return shifts<select value={returnPattern} onChange={event => { const value = event.target.value as typeof returnPattern; setReturnPattern(value); saveSettings(draft => { draft.returnPattern = value; }); }}><option value="consecutive">Keep together as a block</option><option value="separate">Separate days</option><option value="noPreference">No preference</option></select></label>
          <label className="field">Return day type<select value={returnDayType} onChange={event => { const value = event.target.value as typeof returnDayType; setReturnDayType(value); saveSettings(draft => { draft.returnDayType = value; }); }}><option value="noPreference">No preference</option><option value="weekdays">Weekdays</option><option value="weekends">Weekends</option></select></label>
          <label className="field">Return window<select value={returnWindow.kind} onChange={event => { const kind = event.target.value; const value: ReturnWindow = kind === 'weeks' ? { kind, weeks: 4 } : kind === 'dates' ? { kind, from: leaveDates[0] ?? today, to: leaveDates.at(-1) ?? today } : { kind: 'any' }; setReturnWindow(value); saveSettings(draft => { draft.returnWindow = value; }); }}><option value="any">Any time in the imported weeks</option><option value="weeks">Within a number of weeks</option><option value="dates">Between two dates</option></select></label>
          {returnWindow.kind === 'weeks' && <label className="field">Weeks from the leave<input type="number" min="0" max="52" value={returnWindow.weeks} onChange={event => { const value: ReturnWindow = { kind: 'weeks', weeks: Math.max(0, Number(event.target.value)) }; setReturnWindow(value); saveSettings(draft => { draft.returnWindow = value; }); }} /></label>}
          {returnWindow.kind === 'dates' && <div className="grid-2"><label className="field">Return from<input type="date" value={returnWindow.from} onChange={event => { const value = { ...returnWindow, from: event.target.value }; setReturnWindow(value); saveSettings(draft => { draft.returnWindow = value; }); }} /></label><label className="field">Return until<input type="date" value={returnWindow.to} onChange={event => { const value = { ...returnWindow, to: event.target.value }; setReturnWindow(value); saveSettings(draft => { draft.returnWindow = value; }); }} /></label></div>}
      </div>}
      {wizardStep === 5 && <details className="swap-more-options"><summary><b>More options</b></summary><div className="stack">
          <label><input type="checkbox" checked={noAlertsOnly} onChange={event => { const value = event.target.checked; setNoAlertsOnly(value); saveSettings(draft => { draft.noAlertsOnly = value; }); }} /> Only options with no alerts</label>
          <label className="field">Longest chain<select value={maxChain} onChange={event => { const value = Number(event.target.value); setMaxChain(value); saveSettings(draft => { draft.maxChain = value; }); }}><option value={2}>Direct swaps only</option><option value={3}>Up to 3 people</option><option value={4}>Up to 4 people</option></select></label>
          {askMode !== 'only' && <div className="field-block"><span className="field-label">People to leave out</span><MultiSelect label="People to leave out" summary={excluded.length ? personSummary(staff, excluded.filter(id => swapOptionPeople(staff, staffId).some(person => person.id === id))) : 'Nobody'} clearLabel="Nobody" onClear={() => setExcluded([])} sections={[{ title: 'Doctors', options: swapOptionPeople(staff, staffId).map(person => ({ value: person.id, label: person.name })), value: excluded.filter(id => swapOptionPeople(staff, staffId).some(person => person.id === id)), onChange: setExcluded }]} /></div>}
          <label><input type="checkbox" checked={includeNormalDays} onChange={event => { const value = event.target.checked; setIncludeNormalDays(value); saveSettings(draft => { draft.includeNormalDays = value; }); }} /> Also find swaps for normal working days</label>
          <button type="button" className="link-button" onClick={() => go('swapSettings')}>Open Swap settings</button>
        </div></details>}
        {wizardStep === 6 && <>{running && <button type="button" onClick={() => { worker.current?.terminate(); if (timer.current) window.clearInterval(timer.current); worker.current = undefined; timer.current = undefined; setRunning(false); setProgress('Search stopped. Showing the options found so far.'); }}>Stop search</button>}
        {running && <div className="notice" role="status"><b>{progress}</b><div className="small muted">{seconds} seconds.</div></div>}
        {error && <div className="notice bad">The search could not be completed: {error}</div>}</>}
      </div>}
      </>}
      {searchType === 'leave' && wizardStep === 1 && !!data.recentSearches?.length && <section className="swap-recent"><h2>Recent searches</h2><div className="stack">{data.recentSearches.slice(0, 5).map((recent, index) => <button type="button" className="card swap-recent-search" key={`${JSON.stringify(recent)}-${index}`} onClick={() => rerunRecent(recent)}><b>{doctorName(staff, recent.staffId)}</b><span>{recent.leaveDates.map(formatDateLong).join(', ')}</span><small>{recent.askMode === 'only' ? 'Only chosen people' : recent.askMode === 'prefer' ? 'Chosen people first' : 'Everyone'} · up to {recent.maxChain} people</small><span>Start from this</span></button>)}</div></section>}
      {searchType === 'leave' && wizardStep === 6 && <div className="notice swap-disclaimer">These are options to discuss, not approved swaps. Check the shifts in MediRota first, then arrange and record the swap in the usual way.</div>}
      {wizardStep === 6 && visibleResult?.value.stoppedEarly === 'time' && <div className="notice" role="status">Showing the best options found in 60 seconds. <button type="button" disabled={running} onClick={() => runSearch(visibleResult.inputs, {}, undefined, undefined, true)}>Keep looking</button></div>}
      {searchType === 'dayJob' && wizardStep === 3 && dayJobResult ? <DayJobResults result={dayJobResult} date={dayJobDate} requesterName={doctorName(staff, staffId)} /> : searchType === 'leave' && wizardStep === 6 && visibleResult && <Results result={visibleResult.value} staff={staff} requesterId={visibleResult.inputs.staffId} snapshot={data.snapshot} decline={id => decline(id, visibleResult.inputs)} findLongDay={date => findLongDay(date, visibleResult.inputs)} loadMore={loadMore} loading={running} go={go} hasChosenPeople={visibleResult.inputs.askMode !== 'everyone' && !!visibleResult.inputs.askStaffIds?.length} />}
      {wizardStep === 6 && <button type="button" onClick={() => moveStep(2)}>Change my answers</button>}
      <footer className="setup-wizard-actions swap-wizard-footer">
        {wizardStep > 1 && wizardStep < stepTitles.length && <button type="button" onClick={() => moveStep(advanceSwapWizard(searchType, wizardStep, 'back'))}>Back</button>}
        {wizardStep === 3 || leaveStep5SkipStartsSearch(searchType, wizardStep) ? <button type="button" className="link-button" disabled={leaveStep5SkipStartsSearch(searchType, wizardStep) && (!staffId || !leaveDates.length || outside.length > 0)} onClick={() => {
          if (leaveStep5SkipStartsSearch(searchType, wizardStep)) { moveStep(6); runSearch(); return; }
          moveStep(advanceSwapWizard(searchType, wizardStep, 'skip'));
        }}>Skip</button> : null}
        {wizardStep === 2 && noSwapNeeded
          ? <button type="button" className="primary" onClick={() => moveStep(advanceSwapWizard(searchType, wizardStep, 'done', noSwapNeeded))}>Done</button>
          : wizardStep === 5 && searchType === 'leave'
            ? <button type="button" className="primary" disabled={!staffId || !leaveDates.length || outside.length > 0} onClick={() => { moveStep(6); runSearch(); }}>Find swaps</button>
            : wizardStep < stepTitles.length && <button type="button" className="primary" disabled={(wizardStep === 1 && !staffId) || (wizardStep === 2 && searchType === 'leave' && (!leaveDates.length || outside.length > 0))} onClick={() => moveStep(advanceSwapWizard(searchType, wizardStep, 'next', noSwapNeeded))}>Next</button>}
      </footer>
      </section>
    </>
  );
}
