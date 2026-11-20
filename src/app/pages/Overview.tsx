import { Fragment, useMemo, useState } from 'react';
import { addDays, weekday } from '../../engine/calendar';
import type { ISODate } from '../../engine/types';
import { formatDateLong } from '../components/ui';
import { overviewGroups, overviewRange, overviewValidation, sessionFor, shortDays, workingCount, workingMinimumLabel } from '../overview';
import { update, useWorkspace } from '../store';
import type { Page } from './types';

const dayLabel = (date: ISODate) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export function ViewingAs() {
  const ws = useWorkspace();
  const visibleStaff = ws.profile.staff.filter(person => !person.locum || person.regularLocum);
  if (!visibleStaff.length) return null;
  const selected = visibleStaff.find(person => person.id === ws.me) ?? visibleStaff[0];
  return <label className="viewing-as">Viewing as <select aria-label="Viewing as" value={selected.id} onChange={e => update(w => { w.me = e.target.value; })}>{visibleStaff.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>;
}

export function Overview({ go, openPresets }: { go: (page: Page) => void; openPresets: () => void }) {
  const ws = useWorkspace();
  const snapshot = ws.swapFinder?.snapshot;
  const loaded = !!snapshot && Object.keys(snapshot.importedAt).length > 0;
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<{ staffId: string; date: ISODate } | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const range = overviewRange(todayISO(), offset);
  const validation = useMemo(() => snapshot ? overviewValidation(ws.profile, snapshot, range.start, range.end) : null, [ws.profile, snapshot, range.start, range.end]);
  const short = snapshot ? shortDays(snapshot, ws.swapFinder?.settings, range.dates) : new Map<ISODate, number>();
  const totalGaps = validation?.gaps.length ?? 0;
  const breaches = validation?.violations ?? [];
  const groups = ws.profile.groups;
  const visibleStaff = ws.profile.staff.filter(person => !person.locum || person.regularLocum);
  const me = ws.role === 'coordinator' ? undefined : visibleStaff.find(person => person.id === ws.me) ?? visibleStaff[0];
  const grouped = overviewGroups(visibleStaff, groups);
  const displayGroups = [
    ...(ws.role !== 'coordinator' && me ? [{ name: 'Viewing as', people: [me] }] : []),
    ...grouped.map(group => ({ ...group, people: group.people.filter(person => person.id !== me?.id) })).filter(group => group.people.length),
  ];
  const latestImport = snapshot ? Object.values(snapshot.importedAt).sort().at(-1) : undefined;

  if (!loaded) return <section className="overview-empty"><p className="eyebrow">Your rota companion</p><h1>Overview</h1><p>Set up your department or bring in rota weeks from MediRota.</p><div className="overview-empty-actions"><button className="primary" onClick={openPresets}>Load a preset file</button><button onClick={() => go('import')}>Update from MediRota</button></div></section>;

  return <div className="overview-page">
    <header className="overview-head"><div><p className="eyebrow">{ws.profile.name}</p><h1>Overview</h1><p className="muted">{formatDateLong(range.start)} to {formatDateLong(range.end)}</p></div><div className="overview-controls"><button aria-label="Previous 4 weeks" onClick={() => setOffset(n => n - 4)}>Previous</button><button onClick={() => setOffset(0)}>Today</button><button aria-label="Next 4 weeks" onClick={() => setOffset(n => n + 4)}>Next</button></div></header>
    {!snapshot?.extrasTagged && <p className="quiet-note">Extra shifts aren’t marked in this rota yet. Update from MediRota to mark them.</p>}
    <div className="overview-summary">{totalGaps + breaches.length ? <button className="quiet-warning" onClick={() => setShowIssues(v => !v)}>{totalGaps ? `${totalGaps} ${totalGaps === 1 ? 'gap' : 'gaps'}` : ''}{totalGaps && breaches.length ? ', ' : ''}{breaches.length ? `${breaches.length} Must-rule ${breaches.length === 1 ? 'breach' : 'breaches'}` : ''} in the next 4 weeks <span aria-hidden="true">›</span></button> : <span className="quiet-note">No gaps or Must-rule breaches in the next 4 weeks</span>}
      {showIssues && <div className="overview-issues" role="region" aria-label="Rota issues"><h2>To check</h2>{validation?.gaps.map((gap, i) => <p key={`g${i}`}>{formatDateLong(gap.date)}: {ws.profile.roles.find(r => r.id === gap.roleId)?.name ?? 'Place'} is short by {gap.required - gap.assigned}.</p>)}{breaches.map((breach, i) => <p key={`b${i}`}>{breach.date ? `${formatDateLong(breach.date)}: ` : ''}{breach.staffId ? `${ws.profile.staff.find(s => s.id === breach.staffId)?.name ?? ''}: ` : ''}{breach.ruleName}. {breach.message}</p>)}</div>}
    </div>
    <div className="overview-legend">{(ws.sessions?.types ?? []).length ? ws.sessions!.types.map(type => <span key={type.id}><i className={`session-swatch c${type.colour}`} />{type.name}</span>) : <span className="small muted">Session types are not set up yet. Set them in Settings → Sessions and ratios.</span>}<span><i className="session-swatch extra-swatch" />Outlined: extra shift</span></div>
    <div className="overview-grid-wrap"><table className="overview-grid"><thead><tr><th className="overview-person-col">Doctor</th>{range.dates.map(date => <th key={date}><span>{dayLabel(date)}</span>{(weekday(date) === 0 || date === range.start) && <small>{new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short' })}</small>}</th>)}</tr></thead><tbody>
    {displayGroups.map((group, groupIndex) => <Fragment key={`${group.name}-${groupIndex}`}>{groupIndex > 0 && <tr className="overview-group"><th colSpan={range.dates.length + 1}>{group.name}</th></tr>}{group.people.map(person => <tr key={person.id} className={ws.role !== 'coordinator' && person.id === me?.id ? 'overview-me' : ''}><th className="overview-person-col">{person.name}{person.regularLocum && <span className="pill" style={{ marginLeft: 6 }}>Locum</span>}</th>{range.dates.map(date => { const day = snapshot?.days[person.id]?.[date]; const type = sessionFor(day?.activity, ws.profile, ws.sessions); const breach = breaches.some(item => item.staffId === person.id && item.date === date); const gap = validation?.gaps.some(item => item.date === date && item.assigned < item.required); const label = type?.code ?? (day?.status === 'leave' ? 'Leave' : day?.status === 'training' ? 'Train' : day?.status === 'zero' ? 'Zero' : ''); return <td key={date}><button className={`overview-cell ${type ? `c${type.colour}` : ''} ${day?.extra || (person.regularLocum && day && ['night','longDay','partShift','dayJob'].includes(day.status)) ? 'is-extra' : ''} ${breach || gap ? 'has-issue' : ''}`} aria-label={`${person.name}, ${formatDateLong(date)}${day?.activity ? `, ${day.activity}` : day?.status ? `, ${day.status}` : ', no entry'}${day?.extra ? ', extra shift' : person.regularLocum && type ? ', locum shift' : ''}${breach ? ', Must-rule breach' : ''}${gap ? ', gap on day' : ''}`} onClick={() => setSelected({ staffId: person.id, date })}>{label || '·'}{(breach || (gap && person.id === me?.id)) && <i className="cell-issue-dot" />}</button></td>; })}</tr>)}</Fragment>)}
    </tbody><tfoot><tr><th className="overview-person-col">Working / minimum</th>{range.dates.map(date => { const working = snapshot ? workingCount(snapshot, date) : 0; const minimum = ws.swapFinder?.settings.bankHolidays.includes(date) ? ws.swapFinder.settings.minDoctorsBankHoliday : ws.swapFinder?.settings.minDoctors[weekday(date)] ?? 0; const under = minimum > 0 ? (short.get(date) ?? 0) : 0; return <td key={date} className={under ? 'minimum-under' : ''}><span>{workingMinimumLabel(working, minimum)}</span>{under > 0 && <small>−{under}</small>}</td>; })}</tr></tfoot></table></div>
    <p className="overview-asof">Rota as of {latestImport ? new Date(latestImport).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown'}</p>
    {selected && <><button className="side-panel-backdrop" aria-label="Close day details" onClick={() => setSelected(null)} /><aside className="overview-detail" aria-label="Day detail"><button className="overview-close" onClick={() => setSelected(null)} aria-label="Close">×</button><p className="eyebrow">{formatDateLong(selected.date)}</p><h2>{ws.profile.staff.find(s => s.id === selected.staffId)?.name}</h2>{(() => { const day = snapshot?.days[selected.staffId]?.[selected.date]; const person = ws.profile.staff.find(s => s.id === selected.staffId); const issue = breaches.filter(v => v.staffId === selected.staffId && v.date === selected.date); return <><p>{day?.activity ? `Working: ${day.activity}.` : day?.status === 'leave' ? 'On leave.' : day?.status === 'training' ? 'Training.' : day?.status === 'zero' ? 'Zero day.' : day?.status ? 'No listed activity.' : 'No rota entry.'}</p>{(day?.extra || (person?.regularLocum && day && ['night','longDay','partShift','dayJob'].includes(day.status))) && <p className="muted">Extra shift, picked up.</p>}{day?.sessions && <p className="muted">Sessions: {day.sessions.join(', ')}.</p>}{issue.map((item, i) => <p className="quiet-warning detail-warning" key={i}>{item.ruleName}: {item.message}</p>)}</>; })()}</aside></>}
  </div>;
}

export const addFourWeeks = (date: ISODate, direction: -1 | 1) => addDays(date, direction * 28);
