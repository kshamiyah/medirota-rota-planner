import { describe, expect, it } from 'vitest';
import { answer, chooseKind, draftFromRule, emptyDraft, finish, nextBlank, setNumber, setPeriod, setWho } from '../src/app/rules/builder';
import { KINDS, kindOf } from '../src/app/rules/kinds';
import type { Profile, Rule } from '../src/engine/types';

const p: Profile = {
  name: 't',
  shiftTypes: [{ id: 'LD', name: 'Long Day', start: '08:00', end: '20:30' }, { id: 'N', name: 'Night', start: '20:00', end: '08:30' }],
  roles: [{ id: 'mau', name: 'MAU' }, { id: 'oc', name: 'Gynae on-call' }],
  groups: [{ id: 'fy', name: 'FY2' }],
  staff: [{ id: 'a', name: 'Dr A', groupIds: ['fy'], fte: 1 }],
  demands: [], rules: [], fairness: [],
};

describe('rule builder', () => {
  it('asks who, then what kind, then each blank in order', () => {
    let d = emptyDraft();
    expect(nextBlank(d)).toBe('who');
    d = setWho(d, { groupIds: ['fy'] });
    expect(nextBlank(d)).toBe('kind');
    d = chooseKind(p, d, 'atMost', 'r1');
    expect(nextBlank(d)).toBe('amount');
    d = answer(d, 'amount', r => setNumber(r, 'amount', 2));
    d = answer(d, 'work', r => { if (r.type === 'count') r.work = { roleIds: ['oc'] }; });
    expect(finish(p, d)).toBeUndefined();
    d = answer(d, 'period', r => setPeriod(r, 'week'));
    expect(nextBlank(d)).toBe('done');
    expect(finish(p, d)!.name).toBe('FY2 can work at most 2 shifts of Gynae on-call a week');
  });

  it('keeps who and work when you change the kind', () => {
    let d = setWho(emptyDraft(), { groupIds: ['fy'] });
    d = chooseKind(p, d, 'cantWork', 'r1');
    d = answer(d, 'work', r => { if (r.type === 'forbid') r.work = { roleIds: ['oc'] }; });
    d = chooseKind(p, d, 'avoid', 'r1');
    expect(nextBlank(d)).toBe('done');
    expect(finish(p, d)!.name).toBe('FY2 should avoid Gynae on-call');
  });

  it('picking someone for a place rule starts a new kind', () => {
    let d = chooseKind(p, emptyDraft(), 'continuity', 'r1');
    expect(nextBlank(d)).toBe('place');
    d = setWho(d, { groupIds: ['fy'] });
    expect(nextBlank(d)).toBe('kind');
  });

  it('every kind can be built and reopened for editing', () => {
    for (const k of KINDS) {
      let d = k.hasWho ? setWho(emptyDraft(), {}) : emptyDraft();
      d = chooseKind(p, d, k.id, 'r');
      for (const blank of k.ask) d = answer(d, blank, () => {});
      const r = finish(p, d) as Rule;
      expect(r, k.id).toBeDefined();
      expect(kindOf(r).id, k.id).toBe(k.id);
      const again = draftFromRule(r);
      expect(nextBlank(again), k.id).toBe('done');
    }
  });

  it('reopens unfinished example rules at the missing part', () => {
    const r: Rule = { id: 'x', name: '', type: 'minRest', hard: true, hours: 11, unset: ['hours'] };
    expect(nextBlank(draftFromRule(r))).toBe('hours');
  });
});
