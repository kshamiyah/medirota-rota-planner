import type { Profile, Rule, Tier } from '../../engine/types';
import { hasDays, numValue, ruleSegments, type ChoiceKey, type NumKey, type WorkKey } from '../rules/sentence';
import { DaysSelect, WhoSelect, WorkSelect } from './pickers';

/**
 * A rule as a sentence in which every underlined part can be clicked and
 * changed in place: names and work open a tick-list, numbers are typed,
 * choices ("at most", "a week") are small menus.
 */
export function RuleLine({ profile: p, rule: r, onChange }: { profile: Profile; rule: Rule; onChange: (r: Rule) => void }) {
  const set = (fn: (x: Rule) => void) => { const x = structuredClone(r); fn(x); onChange(x); };
  const segments = ruleSegments(r);
  // Example values still to be set are highlighted; setting (or confirming) one clears it.
  const unset = (key: string) => !!r.unset?.includes(key);
  const confirm = (key: string) => (x: Rule) => {
    if (!x.unset) return;
    x.unset = x.unset.filter(k => k !== key);
    if (x.unset.length === 0) delete x.unset;
  };
  const setSlot = (key: string, fn: (x: Rule) => void) => set(x => { fn(x); confirm(key)(x); });
  const touch = (key: string) => () => { if (unset(key)) set(confirm(key)); };

  const setNum = (key: NumKey, n: number) => setSlot(key, x => {
    if (key === 'amount') { if (x.type === 'count') { if (x.min !== undefined) x.min = n; else x.max = n; } return; }
    (x as unknown as Record<string, number>)[key] = n;
  });
  const setChoice = (key: ChoiceKey, value: string) => set(x => {
    if (key === 'direction' && x.type === 'preference') x.direction = value as 'more' | 'less';
    if (x.type !== 'count') return;
    if (key === 'unit') x.unit = value as 'shifts' | 'hours';
    if (key === 'period') {
      if (value === 'avg') { x.period = 'horizon'; x.perWeekAverage = true; } else { x.period = value as 'week' | 'month' | 'horizon'; delete x.perWeekAverage; }
    }
    if (key === 'bound') {
      const n = x.min ?? x.max ?? 1;
      if (value === 'min') { x.min = n; delete x.max; } else { x.max = n; delete x.min; }
    }
  });
  const workOf = (key: WorkKey) => (r as unknown as Record<WorkKey, Parameters<typeof WorkSelect>[0]['value']>)[key];
  const setWork = (key: WorkKey, v: object) => setSlot(key, x => { (x as unknown as Record<WorkKey, object>)[key] = v; });

  return (
    <span className="rule-sentence-line">
      {segments.map((s, i) => {
        switch (s.t) {
          case 'text': return <span key={i} className={s.muted ? 'sentence-quiet slot-optional' : undefined}>{s.text} </span>;
          case 'who': return <WhoSelect key={i} inline unset={unset('who')} onClose={touch('who')} profile={p} value={r.who} emptyLabel={s.emptyLabel} onChange={v => setSlot('who', x => { x.who = v; })} />;
          case 'work': return <span key={i} className={s.quiet && !unset(s.key) ? 'slot-optional' : undefined}><WorkSelect inline muted={s.quiet && !unset(s.key)} unset={unset(s.key)} onClose={touch(s.key)} profile={p} value={workOf(s.key)} onChange={v => setWork(s.key, v)} /> </span>;
          case 'num': {
            const v = numValue(r, s.key);
            return (
              <input key={i} className={`slot slot-num ${unset(s.key) ? 'slot-unset' : ''}`} type="number" aria-label="Number" min={s.min ?? 0} step={s.step ?? 1} value={v}
                title={unset(s.key) ? 'Example number: set your own' : undefined} onBlur={touch(s.key)}
                style={{ width: `${Math.max(1, String(v).length) + 1}ch` }}
                onChange={e => setNum(s.key, Math.max(s.min ?? 0, Number(e.target.value)))} />
            );
          }
          case 'choice': {
            const label = s.options.find(o => o.value === s.value)?.label ?? '';
            return (
              <select key={i} className="slot slot-select" aria-label={s.key} value={s.value} style={{ width: `${label.length * 0.82 + 0.6}ch` }} onChange={e => setChoice(s.key, e.target.value)}>
                {s.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            );
          }
          case 'place':
            return 'roleId' in r ? (
              <select key={i} className={`slot slot-select ${unset('place') ? 'slot-unset' : ''}`} aria-label="Place" value={r.roleId} onBlur={touch('place')} onChange={e => setSlot('place', x => { if ('roleId' in x) x.roleId = e.target.value; })}>
                {p.roles.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            ) : null;
          case 'shift':
            return r.type === 'linkShifts' ? (
              <select key={i} className={`slot slot-select ${unset(`shift${s.index}`) ? 'slot-unset' : ''}`} aria-label="Shift" value={r.shiftTypeIds[s.index]} onBlur={touch(`shift${s.index}`)} onChange={e => setSlot(`shift${s.index}`, x => {
                if (x.type !== 'linkShifts') return;
                const ids = [...x.shiftTypeIds] as [string, string];
                ids[s.index] = e.target.value;
                x.shiftTypeIds = ids;
              })}>
                {p.shiftTypes.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            ) : null;
          default: return null;
        }
      })}
      {hasDays(r) && (() => {
        const days = (r as { days?: { weekdays?: number[] } }).days?.weekdays;
        const any = !days?.length || days.length === 7;
        return (
          <span className={any && !unset('days') ? 'slot-optional' : undefined}>
            {' '}<DaysSelect inline unset={unset('days')} onClose={touch('days')} value={days} onChange={v => setSlot('days', x => { const y = x as { days?: { weekdays?: number[] } }; y.days = { ...y.days, weekdays: v }; })} />
          </span>
        );
      })()}
      {r.type === 'count' && (
        <span className={r.scaleByFte ? undefined : 'slot-optional'}>
          {' '}<button type="button" className={`slot ${r.scaleByFte ? '' : 'slot-muted'}`} title="Give part-timers proportionally less"
            onClick={() => set(x => { if (x.type === 'count') x.scaleByFte = x.scaleByFte ? undefined : true; })}>
            {r.scaleByFte ? '(less for part-timers)' : '(same for part-timers)'}
          </button>
        </span>
      )}
    </span>
  );
}

export function defaultTier(r: Rule): Tier {
  return r.type === 'count' && r.min !== undefined ? 'training' : 'preference';
}

/** "Must" / "Try to: training need" / "Try to: preference", as one small menu shaped like a badge. */
export function StrictnessMenu({ rule: r, onChange }: { rule: Rule; onChange: (r: Rule) => void }) {
  const alwaysTry = r.type === 'preference' || r.type === 'pairPreference' || r.type === 'continuity';
  const value = !alwaysTry && r.hard ? 'must' : r.tier ?? defaultTier(r);
  return (
    <select className={`badge-select ${value === 'must' ? 'must' : 'try'}`} aria-label="How strict" value={value}
      style={{ width: value === 'must' ? '7ch' : '15ch' }}
      title="Must: never broken. Try to: kept wherever possible; a training need comes before fairness, a preference after."
      onChange={e => {
        const x = structuredClone(r);
        if (e.target.value === 'must') { x.hard = true; delete x.tier; } else { x.hard = false; x.tier = e.target.value as Tier; }
        onChange(x);
      }}>
      {!alwaysTry && <option value="must">Must</option>}
      <option value="training">Try to (training)</option>
      <option value="preference">Try to (preference)</option>
    </select>
  );
}
