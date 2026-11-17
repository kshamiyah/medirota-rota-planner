import type { Rule, SkillMixRule } from '../../engine/types';
import { update, useWorkspace } from '../store';
import { mustIncludeOf } from '../rules/grid';
import { describeRule } from '../rules/sentence';
import { describeWho } from '../rules/describe';
import { Cell } from './RuleGrids';
import { WhoSelect } from './pickers';

/**
 * "Must include" for one staffing need: e.g. at least 1 O&G ST1-2 among the
 * doctors on Obstetric on-call nights. Stored as skill-mix rules.
 */
export function MustIncludeCell({ roleId, shiftTypeId }: { roleId: string; shiftTypeId: string }) {
  const ws = useWorkspace();
  const p = ws.profile;
  const mine = p.rules.filter((r): r is SkillMixRule => { const m = mustIncludeOf(r); return !!m && m.roleId === roleId && m.shiftTypeId === shiftTypeId; });
  const place = p.roles.find(r => r.id === roleId)?.name ?? '';
  const shift = p.shiftTypes.find(s => s.id === shiftTypeId)?.name ?? '';
  const edit = (id: string, fn: (r: SkillMixRule) => void) => update(w => {
    const r = w.profile.rules.find(x => x.id === id);
    if (r && r.type === 'skillMix') { fn(r); r.name = describeRule(w.profile, r); }
  });
  const add = () => update(w => {
    const r: Rule = { id: `rule-mix-${Date.now().toString(36)}`, name: '', type: 'skillMix', hard: true, who: w.profile.groups[0] ? { groupIds: [w.profile.groups[0].id] } : {}, work: { roleIds: [roleId], shiftTypeIds: [shiftTypeId] }, min: 1 };
    r.name = describeRule(w.profile, r);
    w.profile.rules.push(r);
  });
  const label = mine.length === 0 ? 'anyone' : mine.map(r => `≥${r.min} ${describeWho(p, r.who)}`).join(', ');
  return (
    <Cell tone={mine.length ? 'tone-mid' : 'tone-empty'} ariaLabel={`Must include on ${place} ${shift}`} label={<span className="small">{label}</span>}>
      {close => (
        <div className="stack" style={{ gap: 10 }}>
          <b>{place} · {shift}</b>
          <p className="small muted" style={{ margin: 0 }}>Who must be among the doctors here, e.g. at least 1 senior.</p>
          {mine.map(r => (
            <div key={r.id} className="stack" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 8 }}>
              <div className="pop-opt">
                At least
                <input type="number" min={1} value={r.min} style={{ width: 52 }} aria-label="At least" onChange={e => edit(r.id, x => { x.min = Math.max(1, Number(e.target.value)); })} />
                <WhoSelect profile={p} value={r.who} onChange={v => edit(r.id, x => { x.who = v; })} />
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div className="chips" role="group" aria-label="How strict">
                  <button type="button" className={`chip ${r.hard ? 'on' : ''}`} onClick={() => edit(r.id, x => { x.hard = true; delete x.tier; })}>Must</button>
                  <button type="button" className={`chip ${!r.hard ? 'on' : ''}`} onClick={() => edit(r.id, x => { x.hard = false; })}>Try to</button>
                </div>
                <button className="ghost danger small" onClick={() => update(w => { w.profile.rules = w.profile.rules.filter(x => x.id !== r.id); })}>Remove</button>
              </div>
            </div>
          ))}
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <button onClick={add}>+ Add a requirement</button>
            <button className="primary" onClick={close}>Done</button>
          </div>
        </div>
      )}
    </Cell>
  );
}
