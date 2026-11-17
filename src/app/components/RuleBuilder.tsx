import { useState, type ReactNode } from 'react';
import type { Profile, Rule, StaffSelector, Tier, WorkSelector } from '../../engine/types';
import { newId } from '../store';
import { KINDS, NUMBER_CHOICES, PLACEHOLDERS, type Kind } from '../rules/kinds';
import { answer, chooseKind, finish, nextBlank, setNumber, setPeriod, setWho, type Draft } from '../rules/builder';
import { describeDays, favourText, hasDays, numValue, ruleSegments, type NumKey, type WorkKey } from '../rules/sentence';
import { describeLeads, describeWho, describeWork } from '../rules/describe';
import { ruleWarning } from '../rules/warnings';
import { defaultTier } from './RuleLine';

const QUESTIONS: Record<string, string> = {
  who: 'Who is this rule about?', kind: 'What should the rule say?', work: 'Which work?', a: 'Which work?', b: 'And which other work?',
  amount: 'How many?', min: 'How many of them, at least?', hours: 'How many hours?', windowDays: 'In any how many days?',
  maxDays: 'How many in a row, at most?', minDays: 'Blocks of at least how many?', runDays: 'How many in a row?',
  maxWeekends: 'How many weekends, at most?', inWeekends: 'Out of every how many weekends?', period: 'Over what time?',
  place: 'Which place?', shift0: 'Which shift?', shift1: 'And which other shift?', lead: 'Which consultant?',
};
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PERIODS = [{ value: 'week', label: 'a week' }, { value: 'month', label: 'a month' }, { value: 'horizon', label: 'over the whole rota' }, { value: 'avg', label: 'a week on average' }];

type Loose = Record<string, unknown>;

/**
 * Build a rule by picking from lists. The sentence grows at the top as you
 * pick; underneath is only the list for the next blank. Click any word
 * already in the sentence to change it.
 */
export function RuleBuilder({ profile: p, draft: d, onDraft, onSave, onCancel }: {
  profile: Profile; draft: Draft; onDraft: (d: Draft) => void; onSave: (r: Rule) => void; onCancel: () => void;
}) {
  // The blank being changed, when it isn't simply the next one to answer.
  const [focus, setFocus] = useState<string | null>(null);
  const next = nextBlank(d);
  const active = focus ?? next;
  const kind = d.kindId ? KINDS.find(k => k.id === d.kindId) : undefined;
  const r = d.rule;
  const done = next === 'done';
  const saved = done ? finish(p, d) : undefined;
  const warning = saved && saved.enabled !== false ? ruleWarning(p, saved) : undefined;
  const started = d.filled.length > 0 || !!d.kindId;

  const go = (key: string) => setFocus(key === 'kind' && kind && !kind.hasWho ? 'who' : key);
  const pickedThen = (nd: Draft) => { onDraft(nd); setFocus(null); };

  return (
    <div className="card builder">
      <div className="builder-head">
        <h2 style={{ margin: 0 }}>{d.editingId ? 'Change this rule' : 'Add a rule'}</h2>
        {started && !d.editingId && <button className="ghost small" onClick={() => { setFocus(null); onCancel(); }}>Start again</button>}
      </div>

      <div className="builder-sentence" aria-live="polite">
        <Sentence p={p} d={d} active={active} go={go} />
      </div>
      {started && <div className="small muted" style={{ marginTop: 4 }}>Click any word to change it.</div>}
      {warning && <div className="rule-warning" style={{ marginTop: 4 }}>⚠ {warning}</div>}

      <div className="builder-step">
        {active !== 'done' && <div className="builder-q">{active === 'kind' ? `What should the rule say about ${describeWho(p, d.who)}?` : QUESTIONS[active]}</div>}
        {active === 'who' && <WhoStep p={p} d={d} onDraft={nd => { onDraft(nd); setFocus('who'); }} onNext={() => setFocus(null)} onKind={k => pickedThen(chooseKind(p, { ...d, filled: d.filled.filter(f => f !== 'who') }, k.id, newId('rule')))} />}
        {active === 'kind' && <KindStep d={d} onPick={k => pickedThen(chooseKind(p, d, k.id, newId('rule')))} />}
        {r && (active === 'work' || active === 'a' || active === 'b') && (
          <WorkStep p={p} kind={kind!} value={(r as unknown as Record<WorkKey, WorkSelector>)[active]}
            onChange={(v, advance) => { onDraft(answer(d, active, x => { (x as unknown as Loose)[active] = v; })); setFocus(advance ? null : active); }} />
        )}
        {r && active in NUMBER_CHOICES && (
          <NumberStep r={r} k={active as NumKey} filled={d.filled.includes(active)}
            onUnit={u => onDraft({ ...d, rule: { ...r, unit: u } as Rule })}
            onPick={n => pickedThen(answer(d, active, x => setNumber(x, active as NumKey, n)))} />
        )}
        {r && active === 'period' && r.type === 'count' && (
          <Chips items={PERIODS.map(o => ({ key: o.value, label: o.label, on: d.filled.includes('period') && (r.perWeekAverage ? 'avg' : r.period) === o.value }))}
            onPick={v => pickedThen(answer(d, 'period', x => setPeriod(x, v)))} />
        )}
        {r && active === 'place' && 'roleId' in r && (
          <Chips items={p.roles.map(o => ({ key: o.id, label: o.name, on: d.filled.includes('place') && r.roleId === o.id }))}
            onPick={v => pickedThen(answer(d, 'place', x => { if ('roleId' in x) x.roleId = v; }))} />
        )}
        {r && (active === 'shift0' || active === 'shift1') && r.type === 'linkShifts' && (
          <Chips items={p.shiftTypes.map(o => ({ key: o.id, label: o.name, on: d.filled.includes(active) && r.shiftTypeIds[active === 'shift0' ? 0 : 1] === o.id }))}
            onPick={v => pickedThen(answer(d, active, x => { if (x.type === 'linkShifts') x.shiftTypeIds[active === 'shift0' ? 0 : 1] = v; }))} />
        )}
        {r && active === 'lead' && r.type === 'workWith' && (
          (p.leads ?? []).length === 0
            ? <p className="small muted">No consultants yet. Add them on the Places page, or import a MediRota week there.</p>
            : <>
                <Chips items={(p.leads ?? []).map(l => ({ key: l.id, label: l.name, on: r.leadIds.includes(l.id) }))}
                  onPick={id => {
                    const nd = answer(d, 'lead', x => { if (x.type === 'workWith') x.leadIds = x.leadIds.includes(id) ? x.leadIds.filter(i => i !== id) : [...x.leadIds, id]; });
                    if (nd.rule?.type === 'workWith' && nd.rule.leadIds.length === 0) nd.filled = nd.filled.filter(f => f !== 'lead');
                    onDraft(nd); setFocus('lead');
                  }} />
                {r.leadIds.length > 0 && <NextButton onClick={() => setFocus(null)} />}
              </>
        )}
        {r && active === 'done' && <Finishing p={p} d={d} kind={kind!} onDraft={onDraft} />}
      </div>

      {done && (
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 14 }}>
          {d.editingId && <button onClick={() => { setFocus(null); onCancel(); }}>Cancel</button>}
          {focus && focus !== 'done' && <button onClick={() => setFocus(null)}>Back</button>}
          <button className="primary" disabled={!saved} onClick={() => { if (saved) { setFocus(null); onSave(saved); } }}>{d.editingId ? 'Save changes' : 'Add rule'}</button>
        </div>
      )}
    </div>
  );
}

/** The rule so far, with every picked word clickable and the next blank highlighted. */
function Sentence({ p, d, active, go }: { p: Profile; d: Draft; active: string; go: (key: string) => void }) {
  const r = d.rule;
  const filled = (k: string) => d.filled.includes(k);
  const W = (key: string, text: string, i: number | string, opts: { quiet?: boolean; title?: string } = {}) => (
    <button key={i} type="button" title={opts.title}
      className={`bword ${filled(key) ? '' : 'blank'} ${active === key ? 'active' : ''} ${opts.quiet ? 'quiet' : ''}`}
      onClick={() => go(key)}>{filled(key) ? text : PLACEHOLDERS[key] ?? '…'}</button>
  );
  const kindText = (text: string, i: number) => (
    <button key={i} type="button" className={`btext ${active === 'kind' ? 'active' : ''}`} title="Change the kind of rule" onClick={() => go('kind')}>{text}</button>
  );
  if (!r) {
    return (
      <>
        {W('who', describeWho(p, d.who), 'who')}
        {' '}
        <button type="button" className={`bword blank ${active === 'kind' ? 'active' : ''}`} onClick={() => go('kind')}>{filled('who') ? '…what rule?' : '…'}</button>
      </>
    );
  }
  const out: ReactNode[] = [];
  ruleSegments(r).forEach((s, i) => {
    switch (s.t) {
      case 'text': if (!(s.muted && filled('work'))) out.push(kindText(s.text.trim(), i)); break;
      case 'who': {
        const who = describeWho(p, r.who);
        out.push(W('who', who === 'Everyone' && s.emptyLabel ? s.emptyLabel : who, i));
        break;
      }
      case 'work': {
        const w = (r as unknown as Record<WorkKey, WorkSelector>)[s.key];
        out.push(W(s.key, s.quiet ? `of ${describeWork(p, w)}` : describeWork(p, w), i, { quiet: s.quiet && filled(s.key) }));
        break;
      }
      case 'num': out.push(W(s.key, String(numValue(r, s.key)), i)); break;
      case 'choice':
        if (s.key === 'unit') { if (filled('amount')) out.push(W('amount', s.options.find(o => o.value === s.value)?.label ?? '', i)); }
        else if (s.key === 'period') out.push(W('period', s.options.find(o => o.value === s.value)?.label ?? '', i));
        else out.push(kindText(s.options.find(o => o.value === s.value)?.label ?? '', i));
        break;
      case 'place': out.push(W('place', 'roleId' in r ? p.roles.find(x => x.id === r.roleId)?.name ?? '' : '', i)); break;
      case 'lead': out.push(W('lead', r.type === 'workWith' ? describeLeads(p, r.leadIds) : '', i)); break;
      case 'shift': out.push(W(`shift${s.index}`, r.type === 'linkShifts' ? p.shiftTypes.find(x => x.id === r.shiftTypeIds[s.index])?.name ?? '' : '', i)); break;
    }
  });
  const days = (r as { days?: { weekdays?: number[] } }).days?.weekdays;
  if (hasDays(r) && days?.length && days.length < 7) out.push(<button key="days" type="button" className="bword" onClick={() => go('done')}>on {describeDays(days)}</button>);
  if (r.type === 'share' && r.favour) out.push(<button key="favour" type="button" className="bword" onClick={() => go('done')}>{favourText(p, r.favour)}</button>);
  if (r.type === 'count' && r.scaleByFte) out.push(<button key="fte" type="button" className="bword quiet" onClick={() => go('done')}>(less for part-timers)</button>);
  return <>{out.flatMap((n, i) => (i ? [' ', n] : [n]))}</>;
}

function Chips({ items, onPick }: { items: { key: string; label: string; on?: boolean; hint?: string }[]; onPick: (key: string) => void }) {
  return (
    <div className="bchips">
      {items.map(o => <button key={o.key} type="button" className={`bchip ${o.on ? 'on' : ''}`} title={o.hint} onClick={() => onPick(o.key)}>{o.label}</button>)}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return <div className="bsection"><div className="bsection-title">{title}</div>{children}</div>;
}

function WhoStep({ p, d, onDraft, onNext, onKind }: { p: Profile; d: Draft; onDraft: (d: Draft) => void; onNext: () => void; onKind: (k: Kind) => void }) {
  const v: StaffSelector = d.who;
  const any = !v.groupIds?.length && !v.staffIds?.length;
  const toggle = (field: 'groupIds' | 'staffIds', id: string) => {
    const cur = v[field] ?? [];
    onDraft(setWho(d, { ...v, [field]: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }));
  };
  return (
    <>
      <Chips items={[{ key: 'all', label: 'Everyone', on: d.filled.includes('who') && any }]} onPick={() => { onDraft(setWho(d, {})); onNext(); }} />
      {p.groups.length > 0 && <Section title="Groups"><Chips items={p.groups.map(g => ({ key: g.id, label: g.name, on: !!v.groupIds?.includes(g.id) }))} onPick={id => toggle('groupIds', id)} /></Section>}
      {p.staff.length > 0 && <Section title="Or particular people"><Chips items={p.staff.map(s => ({ key: s.id, label: s.name, on: !!v.staffIds?.includes(s.id) }))} onPick={id => toggle('staffIds', id)} /></Section>}
      {d.filled.includes('who') && !any && <NextButton onClick={onNext} />}
      <Section title="Or a rule about a place">
        <Chips items={KINDS.filter(k => !k.hasWho).map(k => ({ key: k.id, label: k.phrase, on: d.kindId === k.id }))} onPick={id => onKind(KINDS.find(k => k.id === id)!)} />
      </Section>
    </>
  );
}

function KindStep({ d, onPick }: { d: Draft; onPick: (k: Kind) => void }) {
  const groups = [...new Set(KINDS.map(k => k.group))];
  return (
    <div className="kind-cols">
      {groups.map(g => (
        <div key={g} className="kind-col">
          <div className="bsection-title">{g}</div>
          {KINDS.filter(k => k.group === g && k.hasWho).map(k => (
            <button key={k.id} type="button" className={`kind-opt ${d.kindId === k.id ? 'on' : ''}`} onClick={() => onPick(k)}>{k.phrase}</button>
          ))}
        </div>
      ))}
    </div>
  );
}

function WorkStep({ p, kind, value, onChange }: { p: Profile; kind: Kind; value: WorkSelector | undefined; onChange: (v: WorkSelector, advance: boolean) => void }) {
  const v = value ?? {};
  const any = !v.roleIds?.length && !v.categories?.length && !v.shiftTypeIds?.length;
  const categories = [...new Set(p.roles.map(r => r.category).filter((c): c is string => !!c))];
  const toggle = (field: 'roleIds' | 'categories' | 'shiftTypeIds', id: string) => {
    const cur = v[field] ?? [];
    onChange({ ...v, [field]: cur.includes(id) ? cur.filter(x => x !== id) : [...cur, id] }, false);
  };
  const shifts = (
    <Section key="shifts" title={kind.group === 'Hours and rest' ? 'Shifts' : 'Only on these shifts (optional)'}>
      <Chips items={p.shiftTypes.map(s => ({ key: s.id, label: s.name, on: !!v.shiftTypeIds?.includes(s.id) }))} onPick={id => toggle('shiftTypeIds', id)} />
    </Section>
  );
  const places = (
    <Section key="places" title="Places">
      <Chips items={[
        ...categories.map(c => ({ key: `cat:${c}`, label: `Any ${c}`, on: !!v.categories?.includes(c) })),
        ...p.roles.filter(r => !r.parentId).map(r => ({ key: r.id, label: r.name, on: !!v.roleIds?.includes(r.id) })),
      ]} onPick={id => (id.startsWith('cat:') ? toggle('categories', id.slice(4)) : toggle('roleIds', id))} />
    </Section>
  );
  return (
    <>
      <Chips items={[{ key: 'any', label: 'Any work', on: any }]} onPick={() => onChange({}, true)} />
      {kind.group === 'Hours and rest' ? [shifts, places] : [places, shifts]}
      {!any && <NextButton onClick={() => onChange(v, true)} />}
    </>
  );
}

function NumberStep({ r, k, filled, onUnit, onPick }: { r: Rule; k: NumKey; filled: boolean; onUnit: (u: 'shifts' | 'hours') => void; onPick: (n: number) => void }) {
  const current = numValue(r, k);
  const [other, setOther] = useState('');
  const hoursUnit = r.type === 'count' && r.unit === 'hours';
  const choices = k === 'amount' && hoursUnit ? [4, 8, 12, 24, 37.5, 40, 48] : NUMBER_CHOICES[k];
  const n = Number(other);
  return (
    <>
      {k === 'amount' && r.type === 'count' && (
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="small muted">Count</span>
          <Chips items={[{ key: 'shifts', label: 'shifts', on: !hoursUnit }, { key: 'hours', label: 'hours', on: hoursUnit }]} onPick={u => onUnit(u as 'shifts' | 'hours')} />
        </div>
      )}
      <div className="row">
        <Chips items={choices.map(c => ({ key: String(c), label: String(c), on: filled && current === c }))} onPick={c => onPick(Number(c))} />
        <form className="row" onSubmit={e => { e.preventDefault(); if (other !== '' && n >= 0) { onPick(n); setOther(''); } }}>
          <input type="number" min={0} step={hoursUnit ? 0.5 : 1} placeholder="other" aria-label="Another number" value={other} onChange={e => setOther(e.target.value)} style={{ width: 72 }} />
          {other !== '' && <button type="submit">OK</button>}
        </form>
      </div>
    </>
  );
}

/** Once every blank is answered: optional days, part-timers, and how strict. */
function Finishing({ p, d, kind, onDraft }: { p: Profile; d: Draft; kind: Kind; onDraft: (d: Draft) => void }) {
  const r = d.rule!;
  const set = (fn: (x: Rule) => void) => { const x = structuredClone(r); fn(x); onDraft({ ...d, rule: x }); };
  const days = (r as { days?: { weekdays?: number[] } }).days?.weekdays ?? [];
  const strict = !kind.alwaysTry && r.hard ? 'must' : r.tier ?? defaultTier(r);
  return (
    <div className="stack" style={{ gap: 12 }}>
      {(!kind.alwaysTry || kind.tierChoice) && (
        <Section title="How strict?">
          <Chips items={[
            ...(kind.alwaysTry ? [] : [{ key: 'must', label: 'Must (never broken)', on: strict === 'must' }]),
            { key: 'training', label: 'Try to: a training need', on: strict === 'training', hint: 'Kept wherever possible, before work is shared out fairly' },
            { key: 'preference', label: 'Try to: a preference', on: strict === 'preference', hint: 'Kept wherever possible, after fairness' },
          ]} onPick={v => set(x => { if (v === 'must') { x.hard = true; delete x.tier; } else { x.hard = false; x.tier = v as Tier; } })} />
        </Section>
      )}
      {hasDays(r) && (
        <Section title="Only on certain days? (optional)">
          <Chips items={[{ key: 'any', label: 'Any day', on: days.length === 0 || days.length === 7 }, ...DAY_NAMES.map((n, i) => ({ key: String(i), label: n, on: days.includes(i) }))]}
            onPick={k => set(x => {
              const y = x as { days?: { weekdays?: number[] } };
              const cur = y.days?.weekdays ?? [];
              const i = Number(k);
              const wd = k === 'any' ? [] : cur.includes(i) ? cur.filter(c => c !== i) : [...cur, i].sort();
              y.days = { ...y.days, weekdays: wd as (0 | 1 | 2 | 3 | 4 | 5 | 6)[] };
            })} />
        </Section>
      )}
      {r.type === 'count' && (
        <Section title="Part-timers">
          <Chips items={[{ key: 'same', label: 'The same', on: !r.scaleByFte }, { key: 'less', label: 'Less, in proportion to their hours', on: !!r.scaleByFte }]}
            onPick={k => set(x => { if (x.type === 'count') x.scaleByFte = k === 'less' ? true : undefined; })} />
        </Section>
      )}
      {r.type === 'share' && (
        <Section title="Give some people a bigger share? (optional)">
          <Chips items={[{ key: 'none', label: 'No, the same for everyone', on: !r.favour },
            ...p.groups.map(g => ({ key: g.id, label: g.name, on: !!r.favour?.who.groupIds?.includes(g.id) }))]}
            onPick={k => set(x => {
              if (x.type !== 'share') return;
              if (k === 'none') { delete x.favour; return; }
              const ids = x.favour?.who.groupIds ?? [];
              const next = ids.includes(k) ? ids.filter(i => i !== k) : [...ids, k];
              if (next.length === 0) delete x.favour; else x.favour = { who: { groupIds: next }, times: x.favour?.times ?? 2 };
            })} />
          {r.favour && (
            <div className="row" style={{ marginTop: 8 }}>
              <span className="small muted">How much more, per day available?</span>
              <Chips items={[1.25, 1.5, 2, 3].map(t => ({ key: String(t), label: `${t}×`, on: r.favour!.times === t }))}
                onPick={k => set(x => { if (x.type === 'share' && x.favour) x.favour.times = Number(k); })} />
            </div>
          )}
        </Section>
      )}
      {p.staff.length === 0 && <div className="small muted">Tip: add people first so you can make rules for particular people.</div>}
    </div>
  );
}

function NextButton({ onClick }: { onClick: () => void }) {
  return <div style={{ marginTop: 10 }}><button className="primary" onClick={onClick}>Next →</button> <span className="small muted">You can pick more than one.</span></div>;
}
