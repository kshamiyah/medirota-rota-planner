import { useEffect, useMemo, useState } from 'react';
import { dateRange } from '../../engine/calendar';
import { explainGaps } from '../../engine/explain';
import { demandFor } from '../../engine/semantics';
import type { Assignment, ISODate, RotaProblem } from '../../engine/types';
import type { CoverageGap, ValidationReport } from '../../engine/validate';
import { assignmentKey, update, useWorkspace } from '../store';
import { categoryClass, formatDateLong, formatDay } from './ui';
import { awayCode, categoryOf, dayClass, legendGroups, placeCode, shiftCode, staffSections } from './codes';
import { validate } from '../../engine/validate';
import { placeName } from '../placeName';

type Tab = 'doctor' | 'place' | 'fairness' | 'training' | 'gaps';

export function RotaView({ problem, report }: { problem: RotaProblem; report: ValidationReport }) {
  const ws = useWorkspace();
  const p = ws.profile;
  const rota = ws.rota!;
  const [tab, setTab] = useState<Tab>('doctor');
  const [pop, setPop] = useState<{ staffId: string; date: ISODate } | null>(null);
  const dates = dateRange(ws.period.start, ws.period.end);
  const categories = useMemo(() => [...new Set(p.roles.map(r => r.category).filter((c): c is string => !!c))], [p.roles]);
  const locked = new Set(rota.locked ?? []);

  const required = dates.reduce((t, d) => t + p.roles.reduce((tt, r) => tt + p.shiftTypes.reduce((ttt, s) => ttt + demandFor(p, r.id, s.id, d).min, 0), 0), 0);
  const short = report.gaps.reduce((t, g) => t + g.required - g.assigned, 0);
  const trainingRules = p.rules.filter(r => r.type === 'count' && !r.hard && (r.tier ?? 'training') === 'training' && r.enabled !== false);
  const trainingMissed = report.soft.filter(s => trainingRules.some(r => r.id === s.ruleId));
  const problemsAt = new Set(report.violations.map(v => `${v.staffId}|${v.date}`));

  const shift = (id: string) => p.shiftTypes.find(s => s.id === id);
  const role = (id?: string) => (id ? p.roles.find(r => r.id === id) : undefined);
  const person = (id?: string) => p.staff.find(s => s.id === id);
  const byStaffDate = useMemo(() => {
    const m = new Map<string, Assignment[]>();
    for (const a of rota.assignments) {
      const k = `${a.staffId}|${a.date}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(a);
    }
    for (const list of m.values()) list.sort((a, b) => (shift(a.shiftTypeId)?.start ?? '').localeCompare(shift(b.shiftTypeId)?.start ?? ''));
    return m;
  }, [rota.assignments, p.shiftTypes]);

  const setAssignments = (fn: (list: Assignment[]) => Assignment[]) => update(w => {
    if (!w.rota) return;
    w.rota.assignments = fn(w.rota.assignments);
    w.rota.edited = true;
  });
  const roleName = (id?: string) => (id ? placeName(p.roles.find(r => r.id === id)) : undefined) ?? 'Booked commitment';
  const toggleLock = (a: Assignment) => update(w => {
    if (!w.rota) return;
    const k = assignmentKey(a);
    const set = new Set(w.rota.locked ?? []);
    if (set.has(k)) set.delete(k); else set.add(k);
    w.rota.locked = [...set];
  });

  const exportCsv = () => {
    const header = ['Doctor', ...dates];
    const rows = p.staff.map(s => [s.name, ...dates.map(d => (byStaffDate.get(`${s.id}|${d}`) ?? []).map(a => `${shift(a.shiftTypeId)?.name} ${roleName(a.roleId)}`).join(' / '))]);
    const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `rota-${ws.period.start}.csv`;
    a.click();
  };

  return (
    <>
      <div className="stat-row">
        <div className={`stat ${short === 0 ? 'ok' : 'bad'}`}><div className="label">Shifts covered</div><div className="value">{required - short} / {required}</div></div>
        <div className={`stat ${report.violations.length === 0 ? 'ok' : 'bad'}`}><div className="label">"Must" rules broken</div><div className="value">{report.violations.length}</div></div>
        <div className={`stat ${trainingMissed.length === 0 ? 'ok' : 'warn'}`}><div className="label">Training targets missed</div><div className="value">{trainingMissed.length}</div></div>
        <div className="stat"><div className="label">Took</div><div className="value">{rota.seconds.toFixed(0)}s</div></div>
      </div>

      {report.violations.length > 0 && (
        <div className="notice bad">
          <b>Problems to fix</b> (from hand edits, or leave and booked shifts added after the rota was made):
          <ul>{report.violations.slice(0, 8).map((v, i) => <li key={i}>{person(v.staffId)?.name ?? ''} {v.date ? formatDateLong(v.date) : ''}: <b>{v.ruleName}</b>. {v.message}</li>)}</ul>
          {report.violations.length > 8 && <span>…and {report.violations.length - 8} more.</span>}
        </div>
      )}

      <div className="row" style={{ marginBottom: 12 }}>
        <div className="chips">
          {([['doctor', 'By doctor'], ['place', 'By place'], ['fairness', 'Fairness'], ['training', 'Training'], ['gaps', `Gaps (${short})`]] as [Tab, string][]).map(([t, l]) => (
            <button key={t} className={`chip ${tab === t ? 'on' : ''}`} onClick={() => setTab(t)}>{l}</button>
          ))}
        </div>
        <button style={{ marginLeft: 'auto' }} onClick={exportCsv}>Download spreadsheet</button>
      </div>

      {(tab === 'doctor' || tab === 'place') && <Legend categories={categories} />}

      {tab === 'doctor' && (
        <div className="card flush">
          <div className="table-wrap" style={{ maxHeight: '72vh' }}>
            <table className="grid-table rota-grid">
              <thead><tr><th className="sticky-col">Doctor</th>{dates.map(d => { const f = formatDay(d); return <th key={d} className={dayClass(d)}>{f.dow}<br />{f.day} {f.month}</th>; })}</tr></thead>
              <tbody>
                {staffSections(p, ws.period).map(sec => [
                  <tr key={`h-${sec.title}`} className="group-row"><td className="sticky-col">{sec.title}</td><td colSpan={dates.length} /></tr>,
                  ...sec.staff.map(s => (
                    <tr key={s.id} className={pop?.staffId === s.id ? 'row-on' : ''}>
                      <td className="sticky-col">{s.name}{s.fte < 1 ? <span className="small muted"> · {Math.round(s.fte * 100)}%</span> : null}{s.locum ? <span className="pill" style={{ marginLeft: 6 }}>locum</span> : null}</td>
                      {dates.map(d => {
                        const list = byStaffDate.get(`${s.id}|${d}`) ?? [];
                        const away = problem.unavailability.filter(u => u.staffId === s.id && u.date === d);
                        const on = pop?.staffId === s.id && pop.date === d;
                        return (
                          <td key={d} className={dayClass(d)}>
                            <button className={`cell-btn ${on ? 'on' : ''}`} onClick={() => setPop({ staffId: s.id, date: d })}
                              aria-label={`${s.name}, ${formatDateLong(d)}`}>
                              {list.map(a => {
                                const r = role(a.roleId);
                                const lead = r?.leadIds?.length ? ` with ${r.leadIds.map(l => p.leads?.find(x => x.id === l)?.name).filter(Boolean).join(' & ')}` : '';
                                return (
                                  <span key={assignmentKey(a)} title={`${shift(a.shiftTypeId)?.name} ${shift(a.shiftTypeId)?.start}–${shift(a.shiftTypeId)?.end}: ${r ? placeName(r) : 'Booked commitment'}${lead}${a.fixed ? ' (booked)' : ''}${locked.has(assignmentKey(a)) ? ' (locked)' : ''}`}
                                    className={`tag ${categoryClass(categories, categoryOf(r, p.roles))} ${a.fixed ? 'is-booked' : ''} ${locked.has(assignmentKey(a)) ? 'locked' : ''} ${problemsAt.has(`${s.id}|${d}`) ? 'problem' : ''}`}>
                                    {r ? placeCode(r, p.roles) : shiftCode(shift(a.shiftTypeId)?.name)}
                                  </span>
                                );
                              })}
                              {list.length === 0 && away.map((u, i) => { const c = awayCode(u); return <span key={`away-${i}`} className={`tag ${c.cls}`} title={c.label}>{c.code}</span>; })}
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  )),
                ])}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'place' && <PlaceGrid dates={dates} report={report} />}
      {tab === 'fairness' && <FairnessTable report={report} />}
      {tab === 'training' && <TrainingTable report={report} />}
      {tab === 'gaps' && <GapList problem={problem} gaps={report.gaps} />}

      {pop && (
        <SidePanel
          {...pop}
          problem={problem}
          assignments={byStaffDate.get(`${pop.staffId}|${pop.date}`) ?? []}
          locked={locked}
          onClose={() => setPop(null)}
          onRemove={a => setAssignments(list => list.filter(x => assignmentKey(x) !== assignmentKey(a)))}
          onAdd={a => setAssignments(list => [...list.filter(x => !(x.staffId === a.staffId && x.date === a.date && x.shiftTypeId === a.shiftTypeId && !x.fixed)), a])}
          onToggleLock={toggleLock}
          onSwap={(mine, theirs) => setAssignments(list => list.map(x => {
            if (assignmentKey(x) === assignmentKey(mine)) return { ...x, roleId: theirs.roleId };
            if (assignmentKey(x) === assignmentKey(theirs)) return { ...x, roleId: mine.roleId };
            return x;
          }))}
        />
      )}
    </>
  );
}

function Legend({ categories }: { categories: string[] }) {
  const ws = useWorkspace();
  const groups = legendGroups(ws.profile);
  return (
    <div className="legend-bar">
      {groups.map(g => (
        <span key={g.category} className="legend-item">
          <span className={`tag ${categoryClass(categories, g.category === 'Other' ? undefined : g.category)}`}>{g.codes.join(' · ')}</span>
          <span className="small muted">{g.category}</span>
        </span>
      ))}
      <span className="legend-item"><span className="tag is-booked cat-7">DS</span><span className="small muted">booked</span></span>
      <span className="legend-item"><span className="tag locked cat-7">DS</span><span className="small muted">locked</span></span>
      <span className="legend-item"><span className="tag code-leave">AL</span><span className="small muted">leave</span></span>
      <span className="legend-item"><span className="tag code-train">TR</span><span className="small muted">training</span></span>
      <span className="legend-item"><span className="tag code-off">ZD</span><span className="small muted">Zero Day / off</span></span>
    </div>
  );
}

function SidePanel({ staffId, date, problem, assignments, locked, onClose, onRemove, onAdd, onToggleLock, onSwap }: {
  staffId: string; date: ISODate; problem: RotaProblem; assignments: Assignment[]; locked: Set<string>;
  onClose: () => void; onRemove: (a: Assignment) => void; onAdd: (a: Assignment) => void; onToggleLock: (a: Assignment) => void;
  onSwap: (mine: Assignment, theirs: Assignment) => void;
}) {
  const ws = useWorkspace();
  const p = ws.profile;
  const me = p.staff.find(s => s.id === staffId);
  const all = ws.rota?.assignments ?? [];
  const away = problem.unavailability.filter(u => u.staffId === staffId && u.date === date);
  const counts = (roleId: string, shiftTypeId: string) => all.filter(a => a.roleId === roleId && a.shiftTypeId === shiftTypeId && a.date === date).length;
  const roleName = (id?: string) => (id ? placeName(p.roles.find(r => r.id === id)) : undefined) ?? 'Booked commitment';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Swaps: the same shift, someone else's job that day. Checked against the Must rules for both doctors.
  const mine = assignments.find(a => !a.fixed);
  const swaps = useMemo(() => {
    if (!mine) return [];
    const before = (ids: string[]) => validate(problem, all, { staffIds: ids }).violations.length;
    return all.filter(a => a.date === date && a.staffId !== staffId && !a.fixed && a.shiftTypeId === mine.shiftTypeId && a.roleId !== mine.roleId)
      .map(theirs => {
        const swapped = all.map(x => assignmentKey(x) === assignmentKey(mine) ? { ...x, roleId: theirs.roleId } : assignmentKey(x) === assignmentKey(theirs) ? { ...x, roleId: mine.roleId } : x);
        const ids = [staffId, theirs.staffId];
        const after = validate(problem, swapped, { staffIds: ids });
        const broken = after.violations.length > before(ids) ? [...new Set(after.violations.map(v => v.ruleName))] : [];
        return { theirs, broken };
      });
  }, [mine, all, date, staffId, problem]);

  return (
    <aside className="side-panel" role="dialog" aria-label={`${me?.name} on ${formatDateLong(date)}`}>
      <div className="side-head">
        <div>
          <div className="eyebrow">{formatDateLong(date)}</div>
          <h2 style={{ margin: 0 }}>{me?.name}</h2>
          <div className="small muted">{me?.groupIds.map(g => p.groups.find(x => x.id === g)?.name).filter(Boolean).join(', ')}{me?.locum ? ' · locum' : ''}</div>
        </div>
        <button className="ghost" aria-label="Close" onClick={onClose}>×</button>
      </div>

      {away.length > 0 && <div className="notice warn small">{away.map(u => awayCode(u).label).join(', ')}{away.some(u => u.shiftTypeIds) ? ' (part day)' : ''}</div>}

      <div className="side-section">
        <div className="side-title">On this day</div>
        {assignments.length === 0 && <p className="small muted">Nothing.</p>}
        {assignments.map(a => (
          <div key={assignmentKey(a)} className="side-row">
            <div style={{ flex: 1, minWidth: 0 }}>
              <div><b>{roleName(a.roleId)}</b></div>
              <div className="small muted">{p.shiftTypes.find(s => s.id === a.shiftTypeId)?.name} · {a.fixed ? 'booked' : locked.has(assignmentKey(a)) ? 'locked, kept when the rota is made again' : 'chosen by the app'}</div>
            </div>
            {!a.fixed && (
              <div className="row" style={{ gap: 4 }}>
                <button className="ghost small" onClick={() => onToggleLock(a)}>{locked.has(assignmentKey(a)) ? 'Unlock' : 'Lock'}</button>
                <button className="ghost danger small" onClick={() => onRemove(a)}>Remove</button>
              </div>
            )}
          </div>
        ))}
      </div>

      {mine && (
        <div className="side-section">
          <div className="side-title">Swap with</div>
          {swaps.length === 0 && <p className="small muted">Nobody else is on a different {p.shiftTypes.find(s => s.id === mine.shiftTypeId)?.name.toLowerCase()} job this day.</p>}
          {swaps.map(({ theirs, broken }) => (
            <div key={assignmentKey(theirs)} className="side-row">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{p.staff.find(s => s.id === theirs.staffId)?.name} <span className="muted">· {roleName(theirs.roleId)}</span></div>
                <div className={`small ${broken.length ? 'bad-text' : 'ok-text'}`}>{broken.length ? `Would break: ${broken.join(', ')}` : 'No rules broken'}</div>
              </div>
              <button className="small" disabled={broken.length > 0} onClick={() => onSwap(mine, theirs)}>Swap</button>
            </div>
          ))}
        </div>
      )}

      <div className="side-section">
        <div className="side-title">{mine ? 'Change to' : 'Put on'}</div>
        {p.shiftTypes.map(st => {
          const options = p.roles.filter(r => demandFor(p, r.id, st.id, date).max > 0);
          if (options.length === 0) return null;
          return (
            <div key={st.id} style={{ marginBottom: 6 }}>
              <div className="small muted" style={{ fontWeight: 600, margin: '4px 0' }}>{st.name}</div>
              {options.map(r => {
                const d = demandFor(p, r.id, st.id, date);
                const n = counts(r.id, st.id);
                const current = assignments.some(a => a.roleId === r.id && a.shiftTypeId === st.id);
                return (
                  <button key={r.id} className={`opt ghost ${current ? 'current' : ''}`} disabled={current}
                    onClick={() => onAdd({ staffId, date, shiftTypeId: st.id, roleId: r.id })}>
                    {placeName(r)} <span className={`small ${n < d.min ? 'gap-cell' : 'muted'}`}>{n}/{d.min === d.max ? d.min : `${d.min}–${d.max}`}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
    </aside>
  );
}

/** Like MediRota's activity view: a row per place and shift, names in each day, a consultant's list shown with its consultant. */
function PlaceGrid({ dates, report }: { dates: ISODate[]; report: ValidationReport }) {
  const ws = useWorkspace();
  const p = ws.profile;
  const categories = [...new Set(p.roles.map(r => r.category).filter((c): c is string => !!c))];
  const family = (id: string) => [id, ...p.roles.filter(r => r.parentId === id).map(r => r.id)];
  const rows = p.roles.filter(r => !r.parentId).flatMap(r => p.shiftTypes
    .filter(s => dates.some(d => family(r.id).some(id => demandFor(p, id, s.id, d).max > 0)))
    .map(s => ({ r, s })));
  const short = (name: string) => { const parts = name.replace(/,/g, '').split(/\s+/); return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}` : name; };
  const leadName = (id: string) => p.leads?.find(l => l.id === id)?.name ?? '';
  return (
    <div className="card flush">
      <div className="table-wrap" style={{ maxHeight: '72vh' }}>
        <table className="grid-table rota-grid place-grid">
          <thead><tr><th className="sticky-col">Place</th>{dates.map(d => { const f = formatDay(d); return <th key={d} className={dayClass(d)}>{f.dow}<br />{f.day} {f.month}</th>; })}</tr></thead>
          <tbody>
            {rows.map(({ r, s }) => (
              <tr key={`${r.id}|${s.id}`}>
                <td className="sticky-col"><span className={`tag ${categoryClass(categories, r.category)}`}>{placeCode(r, p.roles)}</span> <b>{placeName(r)}</b>{rows.filter(x => x.r.id === r.id).length > 1 && <span className="muted small"> · {s.name}</span>}</td>
                {dates.map(d => {
                  const ids = family(r.id);
                  const here = (ws.rota?.assignments ?? []).filter(a => a.roleId && ids.includes(a.roleId) && a.shiftTypeId === s.id && a.date === d);
                  const need = ids.reduce((t, id) => t + demandFor(p, id, s.id, d).max, 0);
                  const shortBy = report.gaps.filter(g => ids.includes(g.roleId) && g.shiftTypeId === s.id && g.date === d).reduce((t, g) => t + g.required - g.assigned, 0);
                  const leads = [...new Set(here.flatMap(a => p.roles.find(x => x.id === a.roleId)?.leadIds ?? []))];
                  return (
                    <td key={d} className={dayClass(d)} style={{ opacity: need === 0 && here.length === 0 ? 0.35 : 1 }}>
                      {here.map(a => <span key={a.staffId} className={`name-chip ${a.fixed ? 'is-booked' : ''}`} title={p.staff.find(x => x.id === a.staffId)?.name}>{short(p.staff.find(x => x.id === a.staffId)?.name ?? '?')}</span>)}
                      {leads.length > 0 && <span className="lead-note" title={leads.map(leadName).join(' & ')}>{leads.map(l => leadName(l).split(' ').slice(-1)[0]).join(' & ')}</span>}
                      {shortBy > 0 && <span className="gap-cell small">{shortBy} short</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FairnessTable({ report }: { report: ValidationReport }) {
  const ws = useWorkspace();
  const p = ws.profile;
  return (
    <div className="grid-2">
      {p.fairness.map(dim => {
        const rows = report.fairness.filter(f => f.dimensionId === dim.id && f.eligible && f.capacity > 0);
        const total = rows.reduce((t, r) => t + r.load, 0);
        const cap = rows.reduce((t, r) => t + r.capacity, 0);
        return (
          <div className="card flush" key={dim.id}>
            <div style={{ padding: '12px 12px 4px' }}><h2>{dim.name}</h2><p className="small muted">Fair share is in proportion to % time and days available.</p></div>
            <table>
              <thead><tr><th>Doctor</th><th>Got</th><th>Fair share</th><th>Difference</th></tr></thead>
              <tbody>
                {rows.map(r => {
                  const share = cap > 0 ? (r.capacity * total) / cap : 0;
                  const diff = r.load - share;
                  const tol = dim.unit === 'shifts' ? 1 : 0.1 * share + 4;
                  return (
                    <tr key={r.staffId}>
                      <td>{p.staff.find(s => s.id === r.staffId)?.name}</td>
                      <td>{fmt(r.load)}</td><td className="muted">{fmt(share)}</td>
                      <td><span className={`pill ${Math.abs(diff) <= tol ? 'ok' : 'warn'}`}>{diff >= 0 ? '+' : ''}{fmt(diff)}</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

function fmt(n: number): string {
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

function TrainingTable({ report }: { report: ValidationReport }) {
  const ws = useWorkspace();
  const p = ws.profile;
  const rules = p.rules.filter(r => (r.type === 'count' && !r.hard && (r.tier ?? 'training') === 'training') && r.enabled !== false);
  if (rules.length === 0) return <div className="card muted">No training targets set. Add them on the Rules page.</div>;
  return (
    <div className="card flush">
      <table>
        <thead><tr><th>Training target</th><th>Missed</th></tr></thead>
        <tbody>
          {rules.map(r => {
            const misses = report.soft.filter(s => s.ruleId === r.id);
            return (
              <tr key={r.id}>
                <td>{placeName(r)}</td>
                <td>{misses.length === 0 ? <span className="pill ok">All met</span> : (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>{misses.map((m, i) => <li key={i}>{p.staff.find(s => s.id === m.staffId)?.name}: {m.detail}</li>)}</ul>
                )}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function GapList({ problem, gaps }: { problem: RotaProblem; gaps: CoverageGap[] }) {
  const ws = useWorkspace();
  const p = ws.profile;
  const [open, setOpen] = useState<string | null>(null);
  if (gaps.length === 0) return <div className="notice ok">Every required shift is covered.</div>;
  const key = (g: CoverageGap) => `${g.roleId}|${g.shiftTypeId}|${g.date}`;
  return (
    <div className="card flush">
      <table>
        <thead><tr><th>Date</th><th>Place</th><th>Shift</th><th>Short</th><th /></tr></thead>
        <tbody>
          {gaps.map(g => (
            <GapRow key={key(g)} g={g} open={open === key(g)} toggle={() => setOpen(open === key(g) ? null : key(g))} problem={problem}
              roleName={placeName(p.roles.find(r => r.id === g.roleId))} shiftName={p.shiftTypes.find(s => s.id === g.shiftTypeId)?.name ?? g.shiftTypeId} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function GapRow({ g, open, toggle, problem, roleName, shiftName }: { g: CoverageGap; open: boolean; toggle: () => void; problem: RotaProblem; roleName: string; shiftName: string }) {
  const ws = useWorkspace();
  const why = useMemo(() => (open ? explainGaps(problem, ws.rota?.assignments ?? [], [g])[0] : null), [open, problem, ws.rota, g]);
  return (
    <>
      <tr>
        <td>{formatDateLong(g.date)}</td><td><b>{roleName}</b></td><td>{shiftName}</td><td className="gap-cell">{g.required - g.assigned}</td>
        <td><button className="link" onClick={toggle}>{open ? 'Hide' : 'Why?'}</button></td>
      </tr>
      {open && why && (
        <tr><td colSpan={5}>
          <div className="small">What stops each doctor taking it:</div>
          <ul className="small" style={{ columns: 2, margin: '4px 0' }}>
            {why.candidates.map(c => <li key={c.staffId}><b>{ws.profile.staff.find(s => s.id === c.staffId)?.name}</b>: {c.reasons.join('; ')}</li>)}
          </ul>
        </td></tr>
      )}
    </>
  );
}
