import { useEffect, useRef, useState } from 'react';
import type { Profile, Rule } from '../../engine/types';
import { newId, update, useWorkspace } from '../store';
import { PageHead } from '../components/ui';
import { RuleBuilder } from '../components/RuleBuilder';
import { softTier } from '../../engine/semantics';
import { describeRule } from '../rules/sentence';
import { ruleWarning } from '../rules/warnings';
import { KINDS, groupOf, kindOf } from '../rules/kinds';
import { draftFromRule, emptyDraft, type Draft } from '../rules/builder';

export function Rules() {
  const ws = useWorkspace();
  const p = ws.profile;
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [builderKey, setBuilderKey] = useState(0);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [deleted, setDeleted] = useState<{ rule: Rule; index: number } | null>(null);
  const builderRef = useRef<HTMLDivElement>(null);

  // The sentence is the rule's name, so messages elsewhere never show a stale name.
  useEffect(() => {
    if (p.rules.some(r => r.name !== describeRule(p, r))) update(w => { w.profile.rules.forEach(r => { r.name = describeRule(w.profile, r); }); });
  }, [p]);

  const reset = () => { setDraft(emptyDraft()); setBuilderKey(k => k + 1); };
  const save = (r: Rule) => {
    update(w => {
      const i = w.profile.rules.findIndex(x => x.id === r.id);
      if (i >= 0) w.profile.rules[i] = r; else w.profile.rules.push(r);
    });
    setHighlight(r.id);
    reset();
  };
  const edit = (r: Rule) => {
    setDraft(draftFromRule(r));
    setBuilderKey(k => k + 1);
    builderRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  };
  const insert = (rule: Rule, at: number) => {
    update(w => { w.profile.rules.splice(at, 0, { ...rule, name: describeRule(w.profile, rule) }); });
    setHighlight(rule.id);
  };
  const remove = (r: Rule) => {
    setDeleted({ rule: r, index: p.rules.findIndex(x => x.id === r.id) });
    update(w => { w.profile.rules = w.profile.rules.filter(x => x.id !== r.id); });
    if (draft.editingId === r.id) reset();
  };
  const setEnabled = (r: Rule, on: boolean) => update(w => {
    const x = w.profile.rules.find(y => y.id === r.id);
    if (x) { if (on) delete x.enabled; else x.enabled = false; }
  });

  const groups = [...new Set(KINDS.map(k => k.group))];
  const noEffect = p.rules.filter(r => r.enabled !== false && !r.unset?.length && ruleWarning(p, r)).length;
  const toSet = p.rules.filter(r => r.unset?.length).length;

  return (
    <>
      <PageHead title="Rules">
        Build each rule by picking from the lists. The rota always keeps the <b>Must</b> rules, and keeps the <b>Try to</b> rules wherever it can.
      </PageHead>

      <div ref={builderRef}>
        <RuleBuilder key={builderKey} profile={p} draft={draft} onDraft={setDraft} onSave={save} onCancel={reset} />
      </div>

      <div className="rules-list-head">
        <h2 style={{ margin: 0 }}>Your rules</h2>
        <span className="muted small">{p.rules.length} {p.rules.length === 1 ? 'rule' : 'rules'}</span>
      </div>
      {deleted && (
        <div className="notice row">
          <span>Deleted "{describeRule(p, deleted.rule)}".</span>
          <button onClick={() => { insert(deleted.rule, deleted.index); setDeleted(null); }}>Undo</button>
          <button className="ghost" onClick={() => setDeleted(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      {toSet > 0 && <div className="notice warn">{toSet} {toSet === 1 ? 'rule isn\'t' : 'rules aren\'t'} finished yet, so {toSet === 1 ? 'it isn\'t' : 'they aren\'t'} used. Click Edit to finish {toSet === 1 ? 'it' : 'them'}.</div>}
      {noEffect > 0 && <div className="notice warn">{noEffect} {noEffect === 1 ? 'rule has' : 'rules have'} no effect at the moment (marked ⚠).</div>}

      <div className="card flush">
        {p.rules.length === 0 && <div className="empty">No rules yet. Build your first one above.</div>}
        {groups.map(g => {
          const rules = p.rules.filter(r => groupOf(r) === g);
          if (rules.length === 0) return null;
          return (
            <div key={g}>
              <div className="rules-group-title">{g}</div>
              {rules.map(r => (
                <RuleRow key={r.id} rule={r} profile={p} highlighted={highlight === r.id} editing={draft.editingId === r.id}
                  onEdit={() => edit(r)} onEnabled={on => setEnabled(r, on)} onDelete={() => remove(r)}
                  onCopy={() => { const c = { ...structuredClone(r), id: newId('rule') }; insert(c, p.rules.findIndex(x => x.id === r.id) + 1); edit(c); }} />
              ))}
            </div>
          );
        })}
      </div>
    </>
  );
}

function RuleRow({ rule, profile, highlighted, editing, onEdit, onEnabled, onCopy, onDelete }: {
  rule: Rule; profile: Profile; highlighted: boolean; editing: boolean;
  onEdit: () => void; onEnabled: (on: boolean) => void; onCopy: () => void; onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const on = rule.enabled !== false;
  const warning = on ? ruleWarning(profile, rule) : undefined;
  const alwaysTry = !!kindOf(rule).alwaysTry;
  const must = rule.hard && !alwaysTry;
  const tier = softTier(rule);
  useEffect(() => { if (highlighted) ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, [highlighted]);
  return (
    <div ref={ref} className={`rule-row ${on ? '' : 'off'} ${highlighted ? 'flash' : ''} ${editing ? 'editing' : ''}`}>
      <div className="rule-line">
        <label className="switch" title={on ? 'On (click to switch off)' : 'Off (click to switch on)'}>
          <input type="checkbox" checked={on} onChange={e => onEnabled(e.target.checked)} aria-label={on ? 'Switch rule off' : 'Switch rule on'} />
          <span />
        </label>
        <button type="button" className="rule-text" onClick={onEdit} title="Click to change">
          {describeRule(profile, rule)}
          {rule.unset?.length ? <span className="rule-unset-note"> · not finished</span> : null}
          {warning && !rule.unset?.length && <span className="rule-warning" style={{ display: 'block' }}>⚠ {warning}</span>}
          {!on && <span className="small muted" style={{ display: 'block' }}>Switched off</span>}
        </button>
        <span className={`badge ${must ? 'must' : 'try'}`} title={must ? 'Never broken' : tier === 'training' ? 'Kept wherever possible, before fairness' : tier === 'fairness' ? 'Shared evenly once training needs are met' : 'Kept wherever possible, after fairness'}>
          {must ? 'Must' : tier === 'training' ? 'Try to · training' : tier === 'fairness' ? 'Share evenly' : 'Try to'}
        </span>
        <div className="rule-actions">
          <button className="ghost small" onClick={onEdit} title="Change this rule" aria-label="Edit">✎ Edit</button>
          <button className="ghost small" onClick={onCopy} title="Make a copy to change, e.g. for another group" aria-label="Copy">⧉</button>
          <button className="ghost small danger" onClick={onDelete} title="Delete (you can undo)" aria-label="Delete">🗑</button>
        </div>
      </div>
    </div>
  );
}
