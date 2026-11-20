import { useDeferredValue, useMemo, useState, useEffect, useRef, type ReactNode } from 'react';
import { addDays } from '../../engine/calendar';
import type { ISODate } from '../../engine/types';
import { applyImport, CHANGEOVER_WEEKS, consultantListsOnly, MAX_WEEKS, planImport, previewImport, type ImportPlan, type ImportProblem, type ImportResult, type PersonPlan, type Treat } from '../mediImport';
import { importable, isActivityWeek, isPersonWeek, parseActivityWeek, parsePersonWeek, type ActivityWeek, type PersonWeek } from '../medirota';
import { update, useWorkspace } from '../store';
import { formatDateLong, PageHead, WEEKDAY_NAMES } from '../components/ui';
import { FetchBookmarkLink } from '../components/FetchBookmarkLink';
import { appUrl, FETCH_CHANNEL, FETCH_VERSION, fetchWeekDates, fetchedWeekIsEmpty, formatWeekOf, isFetchBundle, makeFetchBookmark, snapToMonday, stopAfterTwoEmptyWeeks, type ParsedFetchedWeek } from '../fetchBookmark';
import { createPlannerProtocol } from '../fetchProtocol';
import { localISODate } from '../swapsView';
import type { Page } from './types';
import { readSetupReview, saveSetupReview } from '../setupReview';
import { placeName } from '../placeName';
import { parseFetchedPersonWeek } from '../fetchedWeek';

/**
 * Importing MediRota weeks as a short wizard: one question per step, and
 * steps with nothing to decide are skipped. The first time it sets up the
 * department; after that it is usually files → check → import.
 */

type Step = 'files' | 'people' | 'activities' | 'needs' | 'review';
const STEPS: { id: Step; label: string }[] = [
  { id: 'files', label: 'Add weeks' },
  { id: 'people', label: 'People' },
  { id: 'activities', label: 'Activities' },
  { id: 'needs', label: 'Staffing needs' },
  { id: 'review', label: 'Check and import' },
];

const TREATS: { value: Treat; label: string }[] = [
  { value: 'night', label: 'Booked night' },
  { value: 'long', label: 'Booked long day' },
  { value: 'dayjob', label: 'Day job' },
  { value: 'leave', label: 'Leave' },
  { value: 'training', label: 'Training' },
  { value: 'zero', label: 'Zero day' },
  { value: 'unavailable', label: 'Not available' },
  { value: 'ignore', label: 'Leave out' },
];
const GROUPS: { title: string; note: string; treats: Treat[] }[] = [
  { title: 'Booked nights', note: 'From medical staffing, so brought in as booked.', treats: ['night'] },
  { title: 'Booked long days', note: 'From medical staffing, so brought in as booked.', treats: ['long'] },
  { title: 'Day jobs', note: 'The places the app fills when it makes the rota.', treats: ['dayjob'] },
  { title: 'Days away', note: 'Leave, training, zero days and days not available.', treats: ['leave', 'training', 'zero', 'unavailable'] },
  { title: 'Left out', note: 'Not brought in: notes, and "Available".', treats: ['ignore'] },
];
const needsPlace = (t: Treat) => t === 'night' || t === 'long' || t === 'dayjob';
const toCheck = (x: PersonPlan) => !x.staffId || x.action !== 'match' || !!x.possible || !!x.from || !!x.until;

/** [0,1,2,3,4,6] → "Mon–Fri, Sun". */
function dayRanges(days: number[]): string {
  if (days.length === 7) return 'Every day';
  const runs: number[][] = [];
  for (const d of [...days].sort()) (runs.length && runs[runs.length - 1].at(-1) === d - 1 ? runs[runs.length - 1].push(d) : runs.push([d]));
  return runs.map(r => (r.length > 2 ? `${WEEKDAY_NAMES[r[0]]}–${WEEKDAY_NAMES[r[r.length - 1]]}` : r.map(d => WEEKDAY_NAMES[d]).join(', '))).join(', ');
}
const short = (d: string) => formatDateLong(d).replace(/ \d{4}$/, '');

/** Which steps have something to decide. */
function stepsFor(plan: ImportPlan | null): Record<Step, boolean> {
  return {
    files: true,
    people: !!plan && (plan.people.some(toCheck) || plan.leavers.length > 0),
    activities: !!plan && plan.activities.some(a => !a.remembered),
    needs: !!plan && plan.needs.length > 0,
    review: !!plan,
  };
}

interface Files { person: PersonWeek[]; activity: ActivityWeek[]; errors: string[] }
type Done = { result: ImportResult; dates: string } | { lists: number };

export function Import({ go, embedded = false, showFetchDone = false, firstTimeFetch = false, setupReview = false, onReturnToSetup }: { go: (p: Page) => void; embedded?: boolean; showFetchDone?: boolean; firstTimeFetch?: boolean; setupReview?: boolean; onReturnToSetup?: () => void }) {
  const ws = useWorkspace();
  const stagedReview = setupReview ? readSetupReview() : undefined;
  const [files, setFiles] = useState<Files>(() => stagedReview ? { person: stagedReview.personWeeks, activity: stagedReview.activityWeeks, errors: [] } : { person: [], activity: [], errors: [] });
  // "Check the details" / full review: BASE locum guess (pre-tick extra-only), keeping any summary fixes.
  const [plan, setPlan] = useState<ImportPlan | null>(() => {
    if (!stagedReview) return null;
    const base = planImport(ws, stagedReview.personWeeks, stagedReview.activityWeeks);
    return {
      ...stagedReview,
      people: stagedReview.people.map(person => {
        const guessed = base.people.find(item => item.mediRotaId === person.mediRotaId);
        return guessed ? { ...person, locum: guessed.locum } : person;
      }),
    };
  });
  const [step, setStep] = useState<Step>('files');
  const [done, setDone] = useState<Done | null>(null);
  const [fetchMode, setFetchMode] = useState(() => new URLSearchParams(location.search).get('fetchFromMediRota') === '1');
  const [fetchStart, setFetchStart] = useState(() => snapToMonday(mondayToday()));
  const [fetchEnd, setFetchEnd] = useState(() => snapToMonday(addDays(mondayToday() as ISODate, 59 * 7)));
  const [fetchState, setFetchState] = useState<{ active: boolean; expected: number; weeks: ParsedFetchedWeek[] }>({ active: false, expected: 0, weeks: [] });
  const [fetchMessage, setFetchMessage] = useState('');
  const [trustOrigin, setTrustOrigin] = useState('');
  const pendingTrust = useRef<{ origin: string; source: MessageEventSource; data: { channel: string; type: string } } | undefined>(undefined);
  const protocolRef = useRef<ReturnType<typeof createPlannerProtocol> | undefined>(undefined);
  const fileRef = useRef<HTMLInputElement>(null);
  const fetchRef = useRef<{ stop: boolean; source?: WindowProxy; origin?: string; trusted: Set<string> }>({ stop: false, trusted: new Set(ws.medirotaFetch?.trustedOrigins ?? []) });
  fetchRef.current.trusted = new Set(ws.medirotaFetch?.trustedOrigins ?? fetchRef.current.trusted);
  const bookmark = useMemo(() => makeFetchBookmark(appUrl()), []);
  const latestRef = useRef({ ws, files });
  latestRef.current = { ws, files };
  useEffect(() => { if (done && fetchMode && firstTimeFetch) window.close(); }, [done, fetchMode, firstTimeFetch]);
  useEffect(() => {
    const protocol = createPlannerProtocol({
      source: (window.opener ?? window) as MessageEventSource,
      reply: { postMessage: (message, targetOrigin) => (window.opener as WindowProxy | null)?.postMessage(message, targetOrigin) },
      isTrusted: origin => fetchRef.current.trusted.has(origin),
      confirmTrust: origin => { setTrustOrigin(origin); return false; },
      saveTrust: origin => {
        fetchRef.current.trusted.add(origin);
        update(w => { w.medirotaFetch = { ...w.medirotaFetch, trustedOrigins: [...new Set([...(w.medirotaFetch?.trustedOrigins ?? []), origin])] }; });
      },
      onMessage: message => {
        if (message.type === 'week') {
          if (fetchRef.current.stop) return;
          const html = typeof message.html === 'string' ? message.html : '';
          const person = parseFetchedPersonWeek(Number(message.status), html);
          const activityHtml = typeof message.activityHtml === 'string' ? message.activityHtml : '';
          const activity = message.activityStatus === 200 && isActivityWeek(activityHtml) ? parseActivityWeek(activityHtml) : undefined;
          if (message.status && /login|sign in|password/i.test(html.slice(0, 4000)) && !person) {
            setFetchMessage("MediRota didn't return a rota. Check you're still logged in, then click the bookmark again.");
            fetchRef.current.stop = true;
            return;
          }
          const status = Number(message.status);
          const received: ParsedFetchedWeek = { start: String(message.start), person, activity, noRota: fetchedWeekIsEmpty(status, !!person) };
          setFetchState(current => {
            const weeks = [...current.weeks, received];
            const stopForNoRota = stopAfterTwoEmptyWeeks(weeks, current.expected);
            if (stopForNoRota) queueMicrotask(() => {
              fetchRef.current.stop = true;
              if (fetchRef.current.source && fetchRef.current.origin) fetchRef.current.source.postMessage({ channel: FETCH_CHANNEL, type: 'stop' }, fetchRef.current.origin);
              setFetchState(state => ({ ...state, active: false, weeks }));
              loadFetched(weeks);
            });
            return { ...current, active: stopForNoRota ? false : current.active, weeks };
          });
        } else if (message.type === 'error') {
          if (!fetchRef.current.stop) setFetchState(current => ({ ...current, weeks: [...current.weeks, { start: String(message.start), error: String(message.message) }] }));
        } else if (message.type === 'done') {
          setFetchState(current => {
            const completed = { ...current, active: false };
            queueMicrotask(() => loadFetched(completed.weeks));
            return completed;
          });
        }
      },
    });
    protocolRef.current = protocol;
    const listener = (event: MessageEvent) => {
      if (event.data?.channel === FETCH_CHANNEL && event.data?.type === 'hello' && event.source) pendingTrust.current = { origin: event.origin, source: event.source, data: event.data };
      const handled = protocol.receive({ origin: event.origin, source: event.source, data: event.data });
      if (handled && event.data?.channel === FETCH_CHANNEL && event.data?.type === 'hello') { fetchRef.current.source = event.source as WindowProxy; fetchRef.current.origin = event.origin; }
      if (handled && event.data?.channel === FETCH_CHANNEL && event.data?.type === 'week' && event.data.status === 200 && isPersonWeek(String(event.data.html ?? ''))) update(workspace => { workspace.medirotaFetch = { ...workspace.medirotaFetch, trustedOrigins: workspace.medirotaFetch?.trustedOrigins ?? [], origin: event.origin }; });
    };
    const ready = () => {
      // Data-free handshake only. Prefer the referrer origin; fall back to '*' like BASE when MediRota strips it.
      const origin = (() => { try { return new URL(document.referrer).origin; } catch { return ''; } })();
      if (new URLSearchParams(location.search).get('fetchFromMediRota') === '1' && window.opener) window.opener.postMessage({ channel: FETCH_CHANNEL, type: 'rota-planner-ready', version: FETCH_VERSION }, origin || '*');
    };
    window.addEventListener('message', listener);
    ready();
    return () => { window.removeEventListener('message', listener); };
  }, []);
  const startFetch = () => {
    const dates = fetchWeekDates(fetchStart, fetchEnd);
    if (!dates.length) { setFetchMessage('Choose a start and end week in order, up to 60 weeks.'); return; }
    const opener = fetchRef.current.source as WindowProxy | undefined;
    if (!opener) { setFetchMessage('Open a MediRota By person week and click the bookmark to start a fetch.'); return; }
    update(w => { w.medirotaFetch = { ...w.medirotaFetch, trustedOrigins: [...(w.medirotaFetch?.trustedOrigins ?? [])], lastEndWeek: fetchEnd }; });
    fetchRef.current.stop = false; setFetchState({ active: true, expected: dates.length, weeks: [] }); setFetchMessage('');
    if (!fetchRef.current.origin) { setFetchMessage('The MediRota tab needs to be trusted before it can receive rota data.'); return; }
    opener.postMessage({ channel: FETCH_CHANNEL, type: 'fetch', dates }, fetchRef.current.origin);
  };
  const stopFetch = () => { fetchRef.current.stop = true; if (fetchRef.current.source && fetchRef.current.origin) fetchRef.current.source.postMessage({ channel: FETCH_CHANNEL, type: 'stop' }, fetchRef.current.origin); setFetchState(s => ({ ...s, active: false })); if (fetchState.weeks.length) loadFetched(fetchState.weeks); };
  const loadFetched = (results: ParsedFetchedWeek[]) => {
    const good = results.flatMap(w => w.person ? [w.person] : []);
    const goodActivity = results.flatMap(w => w.activity ? [w.activity] : []);
    if (good.length) {
      const current = latestRef.current;
      const next = { ...current.files, person: [...new Map([...current.files.person, ...good].map(w => [w.start, w])).values()].sort((a,b) => a.start.localeCompare(b.start)), activity: [...new Map([...current.files.activity, ...goodActivity].map(w => [w.start, w])).values()].sort((a,b) => a.start.localeCompare(b.start)), errors: results.filter(w => !w.person).map(w => `No rota found for w/c ${formatDateLong(w.start)} ${w.start.slice(0, 4)}.`) };
      const importPlan = planImport(current.ws, next.person, next.activity, firstTimeFetch ? { firstTimeSummary: true } : undefined);
      setFiles(next);
      if (fetchMode && firstTimeFetch) {
        // First-time setup: accept into the summary path; bookmark tab closes.
        if (importPlan.firstTime) saveSetupReview(importPlan);
        let result: ImportResult | undefined;
        update(workspace => { result = applyImport(workspace, importPlan); });
        if (result) setDone({ result, dates: `${formatDateLong(importPlan.dates[0]!)} – ${formatDateLong(importPlan.dates.at(-1)!)}` });
      } else {
        // Later imports keep the full review, including when the bookmark tab is used after setup.
        setPlan(importPlan); setStep('files');
      }
    }
  };

  const allowTrust = () => {
    const pending = pendingTrust.current;
    if (!pending || !protocolRef.current) return;
    fetchRef.current.trusted.add(pending.origin);
    update(workspace => { workspace.medirotaFetch = { ...workspace.medirotaFetch, trustedOrigins: [...new Set([...(workspace.medirotaFetch?.trustedOrigins ?? []), pending.origin])] }; });
    fetchRef.current.source = pending.source as WindowProxy;
    fetchRef.current.origin = pending.origin;
    protocolRef.current.receive({ origin: pending.origin, source: pending.source, data: pending.data });
    pendingTrust.current = undefined;
    setTrustOrigin('');
  };
  const cancelTrust = () => { pendingTrust.current = undefined; setTrustOrigin(''); };


  const read = async (list: FileList | File[]) => {
    const person = new Map(files.person.map(w => [w.start, w]));
    const activity = new Map(files.activity.map(w => [w.start, w]));
    const errors: string[] = [];
    for (const f of Array.from(list)) {
      try {
        const html = await f.text();
        let json: unknown; try { json = JSON.parse(html); } catch { json = null; }
        if (isFetchBundle(json)) { for (const week of json.weeks) { if (week.html && isPersonWeek(week.html)) person.set(week.start, parsePersonWeek(week.html)); else errors.push(`No rota found for w/c ${formatDateLong(week.start)} ${week.start.slice(0, 4)}.`); if (week.activityHtml && isActivityWeek(week.activityHtml)) activity.set(week.start, parseActivityWeek(week.activityHtml)); } }
        else if (isPersonWeek(html)) { const w = parsePersonWeek(html); person.set(w.start, w); }
        else if (isActivityWeek(html)) { const w = parseActivityWeek(html); activity.set(w.start, w); }
        else errors.push(`${f.name} isn't a MediRota rota page. Save the "By person" or "By activity" view.`);
      } catch (e) { errors.push(`${f.name}: ${e instanceof Error ? e.message : 'could not read it'}`); }
    }
    const next = { person: [...person.values()].sort((a, b) => a.start.localeCompare(b.start)), activity: [...activity.values()].sort((a, b) => a.start.localeCompare(b.start)), errors };
    setFiles(next);
    setPlan(next.person.length ? planImport(ws, next.person, next.activity) : null);
  };
  const reset = () => { setFiles({ person: [], activity: [], errors: [] }); setPlan(null); setStep('files'); };

  const has = stepsFor(plan);
  const live = STEPS.filter(s => has[s.id]).map(s => s.id);
  const at = live.indexOf(step);
  const next = () => setStep(live[Math.min(live.length - 1, at + 1)]);
  const back = () => setStep(live[Math.max(0, at - 1)]);
  const firstTime = plan?.firstTime ?? (ws.profile.staff.length === 0 && ws.profile.roles.length === 0);

  if (done && fetchMode && firstTimeFetch) return <section className="fetch-tab-done" role="status"><h1>Done. Go back to your Rota Planner tab.</h1><p>Your rota is ready for a quick look.</p><button type="button" className="primary" onClick={() => window.close()}>Close this tab</button></section>;
  if (done && fetchMode && showFetchDone) return <section className="fetch-tab-done" role="status"><h1>Done. Your other Rota Planner tab is up to date.</h1><p>You can close this one.</p><div className="row"><button type="button" className="primary" onClick={() => window.close()}>Close this tab</button><button type="button" onClick={() => go('overview')}>Stay here</button></div></section>;
  if (done && embedded) return null;
  if (done) return (<><PageHead title="Import from MediRota" /><DoneCard done={done} go={go} again={() => { setDone(null); reset(); }} onReturnToSetup={onReturnToSetup} /></>);

  if (fetchMode && !plan) return <FetchPanel mode={fetchMode} minimal setMode={setFetchMode} start={fetchStart} setStart={setFetchStart} end={fetchEnd} setEnd={setFetchEnd} bookmark={bookmark} origin={ws.medirotaFetch?.origin} message={fetchMessage} progress={fetchState} onFetch={startFetch} onStop={stopFetch} onReview={() => loadFetched(fetchState.weeks)} onFile={() => fileRef.current?.click()} onForget={() => update(w => { if (w.medirotaFetch) w.medirotaFetch.trustedOrigins = []; })} trustOrigin={trustOrigin} onAllowTrust={allowTrust} onCancelTrust={cancelTrust} />;

  return (
    <>
      {!embedded && !fetchMode && <PageHead title={firstTime ? 'Set up from MediRota' : 'Import from MediRota'}>
        {firstTime
          ? 'A few short steps: the app reads your doctors, places, leave and booked shifts from MediRota, and you check them before anything changes.'
          : 'Bring in the latest weeks. Leave and booked nights and long days are updated; anything you entered by hand is kept.'}
      </PageHead>}

      {!plan && <FetchPanel mode={fetchMode} minimal={fetchMode} setMode={setFetchMode} start={fetchStart} setStart={setFetchStart} end={fetchEnd} setEnd={setFetchEnd} bookmark={bookmark} origin={ws.medirotaFetch?.origin} message={fetchMessage} progress={fetchState} onFetch={startFetch} onStop={stopFetch} onReview={() => loadFetched(fetchState.weeks)} onFile={() => fileRef.current?.click()} onForget={() => update(w => { if (w.medirotaFetch) w.medirotaFetch.trustedOrigins = []; })} trustOrigin={trustOrigin} onAllowTrust={allowTrust} onCancelTrust={cancelTrust} />}
      {plan && <Stepper step={step} has={has} onStep={setStep} />}

      {step === 'files' && (
        <>
          <input ref={fileRef} type="file" accept=".html,.htm,.json,text/html,application/json" hidden onChange={e => { if (e.target.files) void read(e.target.files); e.target.value = ''; }} />
          <DropZone files={files} onFiles={read} onClear={reset} />
          {!plan && files.activity.length > 0 && <ListsOnly weeks={files.activity} onDone={lists => setDone({ lists })} />}
        </>
      )}
      {plan && step === 'people' && <PeopleStep plan={plan} setPlan={setPlan} />}
      {plan && step === 'activities' && <ActivitiesStep plan={plan} setPlan={setPlan} files={files} />}
      {plan && step === 'needs' && <NeedsStep plan={plan} setPlan={setPlan} />}
      {plan && step === 'review' && <ReviewStep plan={plan} setPlan={setPlan} skipped={STEPS.filter(s => !has[s.id]).map(s => s.label)} />}
      {setupReview && onReturnToSetup && <p><button type="button" className="link-button" onClick={onReturnToSetup}>Return to setup</button></p>}

      {plan && (
        <div className="wizard-nav">
          {at > 0 ? <button onClick={back}>← Back</button> : <span />}
          {step === 'review' ? (
            <button className="primary" onClick={() => {
              let result: ImportResult | undefined;
              update(w => { result = applyImport(w, plan); });
              if (result) setDone({ result, dates: `${formatDateLong(plan.dates[0])} – ${formatDateLong(plan.dates[plan.dates.length - 1])}` });
            }}>Import {plan.personWeeks.length} {plan.personWeeks.length === 1 ? 'week' : 'weeks'}</button>
          ) : (
            <button className="primary" onClick={next}>
              {step === 'files' && live.length === 2 ? 'Continue: nothing new to check' : 'Continue'}
            </button>
          )}
        </div>
      )}
    </>
  );
}

function mondayToday() { const date = new Date(); date.setDate(date.getDate() - ((date.getDay() + 6) % 7)); return localISODate(date); }
function FetchPanel(props: {
  mode: boolean; minimal: boolean; setMode: (v: boolean) => void; start: string; setStart: (v: string) => void; end: string; setEnd: (v: string) => void;
  bookmark: string; origin?: string; message: string; progress: { active: boolean; expected: number; weeks: ParsedFetchedWeek[] };
  onFetch: () => void; onStop: () => void; onReview: () => void; onFile: () => void; onForget: () => void;
  trustOrigin: string; onAllowTrust: () => void; onCancelTrust: () => void;
}) {
  const dates = fetchWeekDates(props.start, props.end);
  const weeks = dates.length;
  return <section className={`card ${props.minimal ? 'fetch-tab-panel' : ''}`}>
    <h1>{props.minimal ? 'Fetch your rota' : 'Fetch from MediRota'}</h1>
    {props.minimal ? <>
      <p>Choose a range of Monday weeks. By default, fetching starts this week and checks up to 60 weeks, stopping after two weeks in a row with no rota.</p>
      {props.trustOrigin && <section className="notice fetch-trust-card" role="dialog" aria-labelledby="fetch-trust-title"><h2 id="fetch-trust-title">Read your rota from {props.trustOrigin}?</h2><p>Your rota stays in this browser.</p><div className="row"><button className="primary" type="button" onClick={props.onAllowTrust}>Allow</button><button type="button" onClick={props.onCancelTrust}>Cancel</button></div></section>}
      <div className="fetch-range"><label className="field">Start week<input aria-label="Start week" type="date" value={props.start} onChange={e => props.setStart(snapToMonday(e.target.value))} /><small className="small muted">{formatWeekOf(props.start)}</small></label><label className="field">End week<input aria-label="End week" type="date" value={props.end} onChange={e => props.setEnd(snapToMonday(e.target.value))} /><small className="small muted">{formatWeekOf(props.end)}</small></label></div>
      <p className="small muted">{weeks > 0 ? `${weeks} ${weeks === 1 ? 'week' : 'weeks'} in range` : 'Choose an end week after the start week.'}</p>
      {props.progress.active ? <button type="button" onClick={props.onStop}>Stop</button> : <button type="button" className="primary" onClick={props.onFetch}>Fetch</button>}
      {props.progress.active && <p role="status">Fetched {props.progress.weeks.length} of {props.progress.expected} weeks</p>}
      {props.message && <div className="notice warn">{props.message}</div>}
      {props.progress.weeks.length > 0 && <ul className="small">{props.progress.weeks.map(week => <li key={week.start}>{formatWeekOf(week.start)}{week.person ? ' · rota found' : week.noRota ? ' · no rota' : ' · could not check'}</li>)}</ul>}
    </> : <>
      <p className="muted">Fetch the By person weeks open to your account, then check them in the usual import steps.</p>
      <div className="row"><FetchBookmarkLink href={props.bookmark}>Fetch from MediRota</FetchBookmarkLink><button type="button" onClick={() => void navigator.clipboard?.writeText(props.bookmark).then(() => alert('Bookmark code copied.'))}>Copy bookmark code</button><button type="button" onClick={props.onFile}>Choose HTML or JSON bundle</button></div>
      <p className="small muted">Drag the link to your bookmarks bar. It reuses the Rota Planner tab when it is still open.</p><p className="small muted">Dragged this before 17 November 2026? Drag it again to get the newer version.</p><button type="button" className="ghost small" onClick={() => props.setMode(!props.mode)}>{props.mode ? 'Hide fetch form' : 'Show fetch form'}</button>
      {props.origin && <p className="small"><a href={props.origin} target="_blank" rel="noreferrer">Open MediRota</a></p>}
      {props.mode && <div className="row" style={{ marginTop: 12 }}><label>Start week <input type="date" value={props.start} onChange={e => props.setStart(snapToMonday(e.target.value))} /><small className="small muted">{formatWeekOf(props.start)}</small></label><label>End week <input type="date" value={props.end} onChange={e => props.setEnd(snapToMonday(e.target.value))} /><small className="small muted">{formatWeekOf(props.end)}</small></label><span>{weeks > 0 ? `${weeks} ${weeks === 1 ? 'week' : 'weeks'}` : 'Choose an end week'}</span>{props.progress.active ? <button type="button" onClick={props.onStop}>Stop</button> : <button type="button" className="primary" onClick={props.onFetch}>Fetch</button>}</div>}
      {props.progress.active && <p role="status">Fetched {props.progress.weeks.length} of {props.progress.expected} weeks</p>}{props.message && <div className="notice warn">{props.message}</div>}
      {props.progress.weeks.some(w => w.noRota || w.error) && <p className="small">{props.progress.weeks.filter(w => w.noRota || w.error).map(w => `No rota found for w/c ${formatDateLong(w.start)} ${w.start.slice(0, 4)}`).join('; ')}</p>}
      {props.progress.weeks.length > 0 && !props.progress.active && <p><button type="button" className="primary" onClick={props.onReview}>Review fetched weeks</button></p>}
      <button type="button" className="ghost small" onClick={props.onForget}>Forget trusted MediRota origins</button>
    </>}
  </section>;
}

function Stepper({ step, has, onStep }: { step: Step; has: Record<Step, boolean>; onStep: (s: Step) => void }) {
  const live = STEPS.filter(s => has[s.id]).map(s => s.id);
  const at = live.indexOf(step);
  return (
    <ol className="wizard-steps" aria-label="Steps">
      {STEPS.map(s => {
        const i = live.indexOf(s.id);
        const state = !has[s.id] ? 'skip' : s.id === step ? 'now' : i < at ? 'done' : 'todo';
        return (
          <li key={s.id} className={state} aria-current={state === 'now' ? 'step' : undefined}>
            <button disabled={!has[s.id]} onClick={() => onStep(s.id)}>
              <span className="dot">{state === 'done' ? '✓' : state === 'skip' ? '–' : i + 1}</span>
              <span className="lbl">{s.label}{state === 'skip' && <small>nothing new</small>}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function DropZone({ files, onFiles, onClear }: { files: Files; onFiles: (f: FileList | File[]) => void; onClear: () => void }) {
  const [over, setOver] = useState(false);
  const weeks = [...new Set([...files.person, ...files.activity].map(w => w.start))].sort();
  // Weeks missing in the middle of what was dropped, which would leave a hole in leave and bookings.
  const gaps: string[] = [];
  for (let i = 1; i < files.person.length; i++) for (let d = addDays(files.person[i - 1].start, 7); d < files.person[i].start; d = addDays(d, 7)) gaps.push(d);
  const noPerson = weeks.filter(w => !files.person.some(p => p.start === w));
  const noActivity = files.activity.length ? files.person.filter(p => !files.activity.some(a => a.start === p.start)).length : 0;
  return (
    <section className="card">
      <label className={`drop ${over ? 'over' : ''}`}
        onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); onFiles(e.dataTransfer.files); }}>
        <input type="file" accept=".html,.htm,.json,text/html,application/json" multiple hidden onChange={e => { if (e.target.files) onFiles(e.target.files); e.target.value = ''; }} />
        <b>{weeks.length ? 'Add more weeks' : 'Drop saved MediRota pages or a fetch bundle (.json) here'}</b>
        <span className="muted small">or click to choose them. Any order, any file names.</span>
      </label>
      <details style={{ marginTop: 10 }} open={!weeks.length}>
        <summary className="small muted">Fastest: use the Fetch from MediRota bookmark</summary>
        <ol className="small" style={{ margin: '8px 0 0', paddingLeft: 20, lineHeight: 1.6 }}>
          <li>Fastest: use the Fetch from MediRota bookmark above. Open a MediRota <b>By person</b> week, click the bookmark, choose the date range and fetch.</li>
          <li>Or save pages by hand: open <b>Rota → By person</b> for a week, with all the juniors showing.</li>
          <li>Save the page (<b>File → Save Page As…</b>, or ⌘S). Do the same for each week you want.</li>
          <li>For consultant lists, also save <b>Rota → By activity</b> for the same weeks.</li>
          <li>Drop all the saved .html files here together.</li>
        </ol>
        <p className="small muted" style={{ marginBottom: 0 }}>Phone numbers on the pages are not read or kept.</p>
      </details>
      {weeks.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="small"><b>{weeks.length} {weeks.length === 1 ? 'week' : 'weeks'}</b> · {formatDateLong(weeks[0])} – {formatDateLong(addDays(weeks[weeks.length - 1], 6))}</span>
            <button className="ghost small" onClick={onClear}>Start again</button>
          </div>
          <div className="week-pills">
            {weeks.map(w => {
              const p = files.person.some(x => x.start === w), a = files.activity.some(x => x.start === w);
              return <span key={w} className="week-pill" title={`${p ? 'By person' : 'No By person page'} · ${a ? 'By activity' : 'no By activity page'}`}>
                {short(w)}<i className={p ? 'on' : ''}>P</i><i className={a ? 'on' : ''}>A</i>
              </span>;
            })}
          </div>
          <p className="small muted" style={{ margin: '6px 0 0' }}>P: By person (doctors, leave, shifts) · A: By activity (consultant lists)</p>
          {(gaps.length > 0 || noPerson.length > 0 || noActivity > 0) && (
            <ul className="file-notes small">
              {gaps.length > 0 && <li className="warn">Missing in between: {gaps.map(short).join(', ')}. Add {gaps.length === 1 ? 'that week' : 'those weeks'} too, or the gap stays empty.</li>}
              {noPerson.length > 0 && <li className="warn">No By person page for {noPerson.map(short).join(', ')}, so only consultant lists come in for {noPerson.length === 1 ? 'that week' : 'those weeks'}.</li>}
              {noActivity > 0 && <li>{noActivity} {noActivity === 1 ? 'week has' : 'weeks have'} no By activity page, so no consultant lists for {noActivity === 1 ? 'it' : 'them'}. That's fine if you don't use them.</li>}
            </ul>
          )}
        </div>
      )}
      {files.errors.length > 0 && <div className="notice warn" style={{ marginTop: 12, marginBottom: 0 }}>{files.errors.map(e => <div key={e}>{e}</div>)}</div>}
    </section>
  );
}

/** Only "By activity" pages: offer just the consultant lists. */
function ListsOnly({ weeks, onDone }: { weeks: ActivityWeek[]; onDone: (lists: number) => void }) {
  return (
    <section className="card">
      <h2>Consultant lists only?</h2>
      <p className="muted">These are <b>By activity</b> pages, which say which consultant runs each list. Add the <b>By person</b> pages for the same weeks to bring in doctors, leave and booked shifts too, or bring in just the lists for places already in the app.</p>
      <button onClick={() => { let n = 0; update(w => { n = consultantListsOnly(w, weeks).days; }); onDone(n); }}>Import consultant lists only</button>
    </section>
  );
}

function StepCard({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="card wizard-card">
      <h2>{title}</h2>
      {intro && <p className="muted" style={{ marginTop: 4 }}>{intro}</p>}
      {children}
    </section>
  );
}

function PeopleStep({ plan, setPlan }: { plan: ImportPlan; setPlan: (p: ImportPlan) => void }) {
  const ws = useWorkspace();
  const setPerson = (id: string, patch: Partial<PersonPlan>) => setPlan({ ...plan, people: plan.people.map(x => (x.mediRotaId === id ? { ...x, ...patch } : x)) });
  const maybe = plan.people.filter(x => x.possible);
  const fresh = plan.people.filter(x => !x.possible && (!x.staffId || x.action !== 'match'));
  const moving = plan.people.filter(x => x.staffId && x.action === 'match' && !x.possible && (x.from || x.until));
  const matched = plan.people.filter(x => !toCheck(x));
  const taken = new Set(plan.people.filter(x => x.action === 'match').map(x => x.staffId));
  const dates = (x: PersonPlan) => (x.from || x.until) && <span className="small muted"> · {[x.from && `starts ${short(x.from)}`, x.until && `leaves after ${short(x.until)}`].filter(Boolean).join(', ')}</span>;

  return (
    <StepCard title="Check the people" intro={plan.firstTime
      ? 'Everyone in these weeks. They go into groups named after their MediRota grade, which your rules can use.'
      : `${matched.length} ${matched.length === 1 ? 'person matches' : 'people match'} someone already in the app. These need a quick look.`}>
      {maybe.length > 0 && (
        <div className="decide">
          <h3>Same person?</h3>
          {maybe.map(x => {
            const same = x.action === 'match' && x.staffId === x.possible!.staffId;
            return (
              <div key={x.mediRotaId} className="decide-row">
                <span><b>{x.name}</b> in MediRota, <b>{x.possible!.name}</b> in the app</span>
                <div className="seg">
                  <button className={same ? 'on' : ''} onClick={() => setPerson(x.mediRotaId, { action: 'match', staffId: x.possible!.staffId })}>Same person</button>
                  <button className={!same ? 'on' : ''} onClick={() => setPerson(x.mediRotaId, { action: 'add', staffId: undefined })}>Someone new</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {fresh.length > 0 && (
        <div className="decide">
          <h3>{plan.firstTime ? 'Doctors' : 'New in MediRota'} <span className="muted small">{fresh.filter(x => x.action !== 'skip').length} to add</span></h3>
          <table className="import-table">
            <tbody>
              {fresh.map(x => (
                <tr key={x.mediRotaId} className={x.action === 'skip' ? 'muted' : ''}>
                  <td><b>{x.name}</b>{dates(x)}</td>
                  <td>{x.grade ?? <span className="muted">no grade</span>}</td>
                  <td>
                    <select value={x.action === 'match' ? `match:${x.staffId}` : x.action} aria-label={`What to do with ${x.name}`} onChange={e => {
                      const v = e.target.value;
                      setPerson(x.mediRotaId, v.startsWith('match:') ? { action: 'match', staffId: v.slice(6) } : { action: v as PersonPlan['action'], staffId: undefined });
                    }}>
                      <option value="add">Add{x.grade ? ` to ${x.grade}` : ''}</option>
                      <option value="skip">Don't add</option>
                      {ws.profile.staff.filter(s => s.id === x.staffId || (!taken.has(s.id) && !(s.endDate && s.endDate < plan.dates[0]))).map(s => <option key={s.id} value={`match:${s.id}`}>Same as {s.name}</option>)}
                    </select>
                  </td>
                  <td><label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={x.locum} onChange={e => setPerson(x.mediRotaId, { locum: e.target.checked })} />Locum</label></td>
                </tr>
              ))}
            </tbody>
          </table>
          {fresh.some(x => x.locum) && <p className="small muted">Locums are only booked when they pick up a shift, so the app never plans them.</p>}
        </div>
      )}

      {moving.length > 0 && (
        <div className="decide">
          <h3>Changeovers</h3>
          <ul className="plain-list">{moving.map(x => <li key={x.mediRotaId}><b>{x.name}</b>{dates(x)}</li>)}</ul>
        </div>
      )}

      {plan.leavers.length > 0 && (
        <div className="decide">
          <h3>Not in these weeks</h3>
          <p className="small muted" style={{ marginTop: 0 }}>{plan.personWeeks.length >= CHANGEOVER_WEEKS
            ? 'Missing from every week, so probably moved on at a changeover. Untick anyone who is still here.'
            : 'MediRota sometimes leaves out people with little on that week, so tick only those who have left.'}</p>
          {plan.leavers.map((l, i) => (
            <label key={l.staffId} className="row" style={{ gap: 8, padding: '4px 0' }}>
              <input type="checkbox" checked={l.markLeft} onChange={e => setPlan({ ...plan, leavers: plan.leavers.map((x, j) => (j === i ? { ...x, markLeft: e.target.checked } : x)) })} />
              <span><b>{l.name}</b> <span className="muted">left after {formatDateLong(l.lastDay)}</span></span>
            </label>
          ))}
        </div>
      )}

      {matched.length > 0 && !plan.firstTime && (
        <details className="small" style={{ marginTop: 14 }}>
          <summary>{matched.length} matched, nothing to do</summary>
          <p className="muted">{matched.map(x => x.name).join(', ')}</p>
        </details>
      )}
    </StepCard>
  );
}

function ActivitiesStep({ plan, setPlan, files }: { plan: ImportPlan; setPlan: (p: ImportPlan) => void; files: Files }) {
  const ws = useWorkspace();
  const places = ws.profile.roles.filter(r => !r.parentId);
  const setActivity = (name: string, patch: Partial<ImportPlan['activities'][number]>) => setPlan({ ...plan, activities: plan.activities.map(a => (a.name === name ? { ...a, ...patch } : a)) });
  const fresh = plan.activities.filter(a => !a.remembered);
  const remembered = plan.activities.filter(a => a.remembered);
  const seniorsOnly = files.activity.length ? importable(files.activity).seniorsOnly : [];

  const row = (a: ImportPlan['activities'][number]) => (
    <div key={a.name} className="act-row">
      <span className="act-name">{a.name}{!plan.firstTime && !a.remembered && <span className="pill warn">new</span>}<small className="muted">{a.days} {a.days === 1 ? 'day' : 'days'}</small></span>
      <span className="act-controls">
        <select value={a.treat} aria-label={`What ${a.name} becomes`} onChange={e => {
          const treat = e.target.value as Treat;
          setActivity(a.name, { treat, placeId: needsPlace(treat) ? a.placeId ?? 'new' : undefined });
        }}>
          {TREATS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
        </select>
        {needsPlace(a.treat) && places.length > 0 && (
          <select value={a.placeId ?? 'new'} aria-label={`Place for ${a.name}`} onChange={e => setActivity(a.name, { placeId: e.target.value })}>
            <option value="new">New place</option>
            {places.map(r => <option key={r.id} value={r.id}>{placeName(r)}</option>)}
          </select>
        )}
      </span>
    </div>
  );
  const grouped = (list: ImportPlan['activities']) => GROUPS.map(g => {
    const rows = list.filter(a => g.treats.includes(a.treat));
    if (!rows.length) return null;
    return (
      <div key={g.title} className="act-group">
        <h3>{g.title} <span className="muted small">{g.note}</span></h3>
        {rows.map(row)}
        {g.treats[0] === 'dayjob' && (
          <label className="row small muted" style={{ gap: 8, marginTop: 8 }}>
            <input type="checkbox" checked={plan.keepDayJobs} onChange={e => setPlan({ ...plan, keepDayJobs: e.target.checked })} />
            Also bring in MediRota's day jobs as booked (only to compare, or to fill just what's left)
          </label>
        )}
      </div>
    );
  });

  return (
    <StepCard title={plan.firstTime ? 'What each activity becomes' : 'New activities'} intro={plan.firstTime
      ? 'Sorted into groups from how MediRota uses them. Move any that are in the wrong group. You won\'t be asked again for these.'
      : `${fresh.length} ${fresh.length === 1 ? 'activity hasn\'t' : 'activities haven\'t'} come up before. The rest are set up as last time.`}>
      {grouped(fresh)}
      {remembered.length > 0 && (
        <details style={{ marginTop: 12 }}>
          <summary className="small">{remembered.length} set up as last time</summary>
          {grouped(remembered)}
        </details>
      )}
      {seniorsOnly.length > 0 && <p className="small muted">Seniors only in the By activity pages, so not used: {seniorsOnly.join(', ')}.</p>}
    </StepCard>
  );
}

function NeedsStep({ plan, setPlan }: { plan: ImportPlan; setPlan: (p: ImportPlan) => void }) {
  return (
    <StepCard title="How many doctors each place needs" intro="Suggested from how many juniors each place usually had. These are what the app fills when it makes the rota; change any number, or untick a place to set it up yourself later.">
      <table className="import-table">
        <thead><tr><th /><th>Place</th><th>Days</th><th className="num">At least</th><th className="num">At most</th></tr></thead>
        <tbody>
          {plan.needs.map((n, i) => {
            const set = (patch: Partial<typeof n>) => setPlan({ ...plan, needs: plan.needs.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
            return (
              <tr key={n.placeName} className={n.create ? '' : 'muted'}>
                <td style={{ width: 28 }}><input type="checkbox" checked={n.create} aria-label={`Add a need for ${n.placeName}`} onChange={e => set({ create: e.target.checked })} /></td>
                <td>{n.placeName} <span className="muted small">{n.treat === 'night' ? 'nights' : n.treat === 'long' ? 'long days' : 'day'}</span></td>
                <td className="small">{dayRanges(n.weekdays)}</td>
                <td className="num"><input type="number" min={0} value={n.min} style={{ width: 58 }} onChange={e => set({ min: Math.max(0, +e.target.value), max: Math.max(n.max, +e.target.value) })} /></td>
                <td className="num"><input type="number" min={n.min} value={n.max} style={{ width: 58 }} onChange={e => set({ max: Math.max(n.min, +e.target.value) })} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="small muted">"At least 0" means nice to have: the app fills it only when there's a doctor to spare.</p>
    </StepCard>
  );
}

function ReviewStep({ plan, setPlan, skipped }: { plan: ImportPlan; setPlan: (p: ImportPlan) => void; skipped: string[] }) {
  const ws = useWorkspace();
  const deferred = useDeferredValue(plan);
  const preview = useMemo(() => previewImport(ws, deferred), [ws, deferred]);
  const stale = deferred !== plan;
  const weekStarts = plan.personWeeks.map(w => w.start);
  const change = (patch: Partial<ImportPlan>) => setPlan({ ...plan, ...patch });

  // Problems grouped by person, so each doctor's clashes read together.
  const byPerson = new Map<string, ImportProblem[]>();
  for (const v of preview.problems) {
    const k = v.name ?? 'Whole team';
    if (!byPerson.has(k)) byPerson.set(k, []);
    byPerson.get(k)!.push(v);
  }
  const nameOf = (id: string) => plan.people.find(p => p.mediRotaId === id)?.name ?? '';

  return (
    <>
      <StepCard title="Rota dates">
        <label className="row" style={{ gap: 8 }}>
          <input type="checkbox" checked={!!plan.period} onChange={e => change({ period: e.target.checked ? { start: weekStarts[0], weeks: Math.min(MAX_WEEKS, weekStarts.length) } : undefined })} />
          Make the next rota for these weeks
        </label>
        {plan.period ? (
          <div className="row" style={{ marginTop: 10, alignItems: 'flex-end' }}>
            <label className="field">Starting<select value={plan.period.start} onChange={e => change({ period: { ...plan.period!, start: e.target.value } })}>
              {weekStarts.map(w => <option key={w} value={w}>Week of {formatDateLong(w)}</option>)}
            </select></label>
            <label className="field">For<select value={plan.period.weeks} onChange={e => change({ period: { ...plan.period!, weeks: +e.target.value } })}>
              {Array.from({ length: MAX_WEEKS }, (_, i) => i + 1).map(n => <option key={n} value={n}>{n} {n === 1 ? 'week' : 'weeks'}</option>)}
            </select></label>
            <span className="muted small" style={{ paddingBottom: 10 }}>to {formatDateLong(addDays(plan.period.start, plan.period.weeks * 7 - 1))}</span>
          </div>
        ) : <p className="small muted" style={{ margin: '6px 0 0' }}>The rota stays {formatDateLong(ws.period.start)} – {formatDateLong(ws.period.end)}. All the weeks are still brought in.</p>}
      </StepCard>

      <StepCard title={preview.problems.length || plan.skip.length ? 'Booked shifts that break a Must rule' : 'Booked shifts'}>
        {preview.problems.length === 0 && <div className="notice ok" style={{ marginBottom: 0 }}>{stale ? 'Checking…' : 'Every booked shift fits your Must rules.'}</div>}
        {preview.problems.length > 0 && (
          <p className="muted" style={{ marginTop: 0 }}>These come from MediRota. Keep a booking if it's really happening (the rota can't be made until it's sorted out), or leave it out of the app.</p>
        )}
        {[...byPerson].map(([name, list]) => (
          <div key={name} className="problem-person">
            <h3>{name}</h3>
            {list.map((v, i) => (
              <div key={i} className="decide-row">
                <span title={v.ruleName}><b>{v.date ? short(v.date) : ''}</b>{v.booking ? ` · ${v.booking}` : ''}<br /><span className="small muted">{v.message}</span></span>
                {v.booking && v.mediRotaId && (
                  <div className="seg">
                    <button className="on">Keep</button>
                    <button onClick={() => change({ skip: [...plan.skip, `${v.mediRotaId}|${v.date}`] })}>Leave out</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ))}
        {plan.skip.length > 0 && (
          <div className="problem-person">
            <h3 className="muted">Left out</h3>
            {plan.skip.map(k => {
              const [id, date] = k.split('|');
              return (
                <div key={k} className="decide-row">
                  <span>{nameOf(id)}, {short(date)}</span>
                  <button className="ghost small" onClick={() => change({ skip: plan.skip.filter(x => x !== k) })}>Put back</button>
                </div>
              );
            })}
          </div>
        )}
      </StepCard>

      <StepCard title="What will change">
        <ul className="import-changes">
          <li><b>{formatDateLong(plan.dates[0])} – {formatDateLong(plan.dates[plan.dates.length - 1])}</b> · {plan.personWeeks.length} {plan.personWeeks.length === 1 ? 'week' : 'weeks'}</li>
          {plan.activityWeeks.length > 0 && <li>{plan.activityWeeks.length} By activity {plan.activityWeeks.length === 1 ? 'week' : 'weeks'} received</li>}
          {plan.activityWeeks.length > 0 && <li>{plan.unmatchedActivityJuniors} unmatched juniors in consultant lists</li>}
          {preview.newPeople > 0 && <li>{preview.newPeople} new {preview.newPeople === 1 ? 'person' : 'people'}</li>}
          {preview.newPlaces > 0 && <li>{preview.newPlaces} new {preview.newPlaces === 1 ? 'place' : 'places'}</li>}
          <li>{preview.leave.after} days away{preview.leave.before ? <span className="muted"> (was {preview.leave.before})</span> : null}</li>
          <li>{preview.booked.after} booked nights and long days{preview.booked.before ? <span className="muted"> (was {preview.booked.before})</span> : null}</li>
          {preview.replaced > 0 && <li>{preview.replaced} {preview.replaced === 1 ? 'booking' : 'bookings'} entered earlier clash with MediRota's and are replaced by them</li>}
          {preview.consultantDays > 0 && <li>Consultant lists on {preview.consultantDays} days</li>}
        </ul>
        {preview.clearsRota && <div className="notice warn small">The rota you've made will be cleared, as its leave and bookings change.</div>}
        <p className="small muted" style={{ marginBottom: 0 }}>
          Anything you entered by hand is kept, and importing the same weeks again just replaces what came from MediRota.
          {skipped.length > 0 && ` Nothing new to check for ${skipped.join(', ').toLowerCase()}.`}
        </p>
      </StepCard>
    </>
  );
}

function DoneCard({ done, go, again, onReturnToSetup }: { done: Done; go: (p: Page) => void; again: () => void; onReturnToSetup?: () => void }) {
  if ('lists' in done) return (
    <section className="card">
      <h2>Consultant lists imported</h2>
      <p>Set on {done.lists} days.</p>
      <div className="row">{onReturnToSetup && <button className="primary" onClick={onReturnToSetup}>Return to setup</button>}<button className={onReturnToSetup ? 'ghost' : 'primary'} onClick={() => go('overview')}>Go to Overview</button><button className="ghost" onClick={again}>Import more</button></div>
    </section>
  );
  const r = done.result;
  return (
    <section className="card wizard-card">
      <h2>Imported</h2>
      <p>{done.dates}: {r.leave} days away and {r.booked} booked shifts{r.people ? `, ${r.people} new people` : ''}{r.places ? `, ${r.places} new places` : ''}{r.consultantDays ? `, consultant lists on ${r.consultantDays} days` : ''}.</p>
      {r.removedHeadingPlace && <p>Removed a place that was a MediRota heading, not an activity.</p>}
      <div className="row">{onReturnToSetup && <button className="primary" onClick={onReturnToSetup}>Return to setup</button>}<button className={onReturnToSetup ? 'ghost' : 'primary'} onClick={() => go('overview')}>Go to Overview</button><button className="ghost" onClick={again}>Import more</button></div>
    </section>
  );
}
