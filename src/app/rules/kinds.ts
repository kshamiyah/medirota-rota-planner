/**
 * The kinds of rule the builder offers. Each is a phrase you pick from a list
 * ("can't work …"), a starting rule, and the blanks it asks for, in order.
 * The blanks are the rule's sentence slots (see sentence.ts); the builder
 * asks for each one by showing a list to pick from.
 */
import type { Profile, Rule } from '../../engine/types';

export type KindId =
  | 'cantWork' | 'avoid' | 'notSameDay' | 'skillMix' | 'wholeDay' | 'continuity'
  | 'atMost' | 'atLeast' | 'more' | 'less' | 'share' | 'pair' | 'workWith' | 'fewLeads'
  | 'rest' | 'maxHours' | 'inARow' | 'blocks' | 'offAfterBlock' | 'offAfterRun' | 'weekends';

export interface Kind {
  id: KindId;
  /** The phrase as it appears in the list, after who it's about. */
  phrase: string;
  group: 'Where people can work' | 'How much' | 'Consultants' | 'Hours and rest';
  /** Whether the rule starts with "who". If not, the builder skips that step. */
  hasWho: boolean;
  /** The blanks to ask for, in order. */
  ask: string[];
  /** "Try to" only (no Must option). */
  alwaysTry?: boolean;
  /** For a "try to" rule: whether it can be a training need as well as a preference. */
  tierChoice?: boolean;
  make: (p: Profile, id: string) => Rule;
}

export const KINDS: Kind[] = [
  { id: 'cantWork', group: 'Where people can work', phrase: "can't work …", hasWho: true, ask: ['who', 'work'],
    make: (_p, id) => ({ id, name: '', type: 'forbid', hard: true, who: {}, work: {} }) },
  { id: 'avoid', group: 'Where people can work', phrase: 'should avoid …', hasWho: true, ask: ['who', 'work'],
    make: (_p, id) => ({ id, name: '', type: 'forbid', hard: false, tier: 'preference', who: {}, work: {} }) },
  { id: 'notSameDay', group: 'Where people can work', phrase: 'never does … and … on the same day', hasWho: true, ask: ['who', 'a', 'b'],
    make: (_p, id) => ({ id, name: '', type: 'notSameDay', hard: true, who: {}, a: {}, b: {} }) },
  { id: 'skillMix', group: 'Where people can work', phrase: 'at least … of them on … every day (skill mix)', hasWho: true, ask: ['who', 'min', 'work'],
    make: (_p, id) => ({ id, name: '', type: 'skillMix', hard: true, who: {}, work: {}, min: 1 }) },
  { id: 'wholeDay', group: 'Where people can work', phrase: 'the same person does both shifts at …', hasWho: false, ask: ['place', 'shift0', 'shift1'],
    make: (p, id) => ({ id, name: '', type: 'linkShifts', hard: true, roleId: p.roles[0]?.id ?? '', shiftTypeIds: [p.shiftTypes[0]?.id ?? '', p.shiftTypes[1]?.id ?? p.shiftTypes[0]?.id ?? ''] }) },
  { id: 'continuity', group: 'Where people can work', phrase: 'the same doctor at … several days running', hasWho: false, ask: ['place', 'runDays'], alwaysTry: true,
    make: (p, id) => ({ id, name: '', type: 'continuity', hard: false, roleId: p.roles[0]?.id ?? '', runDays: 3 }) },

  { id: 'atMost', group: 'How much', phrase: 'can work at most … of …', hasWho: true, ask: ['who', 'amount', 'work', 'period'],
    make: (_p, id) => ({ id, name: '', type: 'count', hard: true, who: {}, work: {}, period: 'week', unit: 'shifts', max: 1 }) },
  { id: 'atLeast', group: 'How much', phrase: 'should get at least … of … (training target)', hasWho: true, ask: ['who', 'amount', 'work', 'period'],
    make: (_p, id) => ({ id, name: '', type: 'count', hard: false, tier: 'training', who: {}, work: {}, period: 'month', unit: 'shifts', min: 1, scaleByFte: true }) },
  { id: 'more', group: 'How much', phrase: 'should get more …', hasWho: true, ask: ['who', 'work'], alwaysTry: true, tierChoice: true,
    make: (_p, id) => ({ id, name: '', type: 'preference', hard: false, who: {}, work: {}, direction: 'more' }) },
  { id: 'less', group: 'How much', phrase: 'should get less …', hasWho: true, ask: ['who', 'work'], alwaysTry: true, tierChoice: true,
    make: (_p, id) => ({ id, name: '', type: 'preference', hard: false, who: {}, work: {}, direction: 'less' }) },
  { id: 'share', group: 'How much', phrase: 'should share … fairly (allowing for time off)', hasWho: true, ask: ['who', 'work'], alwaysTry: true,
    make: (_p, id) => ({ id, name: '', type: 'share', hard: false, who: {}, work: {} }) },
  { id: 'pair', group: 'How much', phrase: 'should do … and … on the same day', hasWho: true, ask: ['who', 'a', 'b'], alwaysTry: true,
    make: (_p, id) => ({ id, name: '', type: 'pairPreference', hard: false, who: {}, a: {}, b: {} }) },

  { id: 'workWith', group: 'Consultants', phrase: 'should work with consultant … on …', hasWho: true, ask: ['who', 'lead', 'work'], alwaysTry: true, tierChoice: true,
    make: (_p, id) => ({ id, name: '', type: 'workWith', hard: false, who: {}, work: {}, leadIds: [] }) },
  { id: 'fewLeads', group: 'Consultants', phrase: 'should see as few different consultants as possible on …', hasWho: true, ask: ['who', 'work'], alwaysTry: true,
    make: (_p, id) => ({ id, name: '', type: 'fewLeads', hard: false, who: {}, work: {} }) },

  { id: 'rest', group: 'Hours and rest', phrase: 'must have at least … hours off between shifts', hasWho: true, ask: ['who', 'hours'],
    make: (_p, id) => ({ id, name: '', type: 'minRest', hard: true, who: {}, hours: 11 }) },
  { id: 'maxHours', group: 'Hours and rest', phrase: 'can work at most … hours in any … days', hasWho: true, ask: ['who', 'hours', 'windowDays'],
    make: (_p, id) => ({ id, name: '', type: 'maxHours', hard: true, who: {}, hours: 72, windowDays: 7 }) },
  { id: 'inARow', group: 'Hours and rest', phrase: 'can work at most … in a row', hasWho: true, ask: ['who', 'maxDays', 'work'],
    make: (_p, id) => ({ id, name: '', type: 'maxConsecutive', hard: true, who: {}, work: {}, maxDays: 4 }) },
  { id: 'blocks', group: 'Hours and rest', phrase: 'work … in blocks of at least … (no singles)', hasWho: true, ask: ['who', 'work', 'minDays'],
    make: (_p, id) => ({ id, name: '', type: 'minBlock', hard: true, who: {}, work: {}, minDays: 2 }) },
  { id: 'offAfterBlock', group: 'Hours and rest', phrase: 'must have … hours off after a run of …', hasWho: true, ask: ['who', 'hours', 'work'],
    make: (_p, id) => ({ id, name: '', type: 'restAfterBlock', hard: true, who: {}, work: {}, hours: 46 }) },
  { id: 'offAfterRun', group: 'Hours and rest', phrase: 'must have … hours off after … in a row', hasWho: true, ask: ['who', 'hours', 'runDays', 'work'],
    make: (_p, id) => ({ id, name: '', type: 'restAfterRun', hard: true, who: {}, work: {}, runDays: 4, hours: 48 }) },
  { id: 'weekends', group: 'Hours and rest', phrase: 'can work at most … in every … weekends', hasWho: true, ask: ['who', 'maxWeekends', 'inWeekends'],
    make: (_p, id) => ({ id, name: '', type: 'weekendFrequency', hard: true, who: {}, maxWeekends: 1, inWeekends: 2 }) },
];

/** Which kind an existing rule is, so Edit can reopen it in the builder. */
export function kindOf(r: Rule): Kind {
  const id: KindId = (() => {
    switch (r.type) {
      case 'forbid': return r.hard ? 'cantWork' : 'avoid';
      case 'notSameDay': return 'notSameDay';
      case 'skillMix': return 'skillMix';
      case 'linkShifts': return 'wholeDay';
      case 'continuity': return 'continuity';
      case 'count': return r.min !== undefined ? 'atLeast' : 'atMost';
      case 'preference': return r.direction === 'more' ? 'more' : 'less';
      case 'pairPreference': return 'pair';
      case 'share': return 'share';
      case 'workWith': return 'workWith';
      case 'fewLeads': return 'fewLeads';
      case 'minRest': return 'rest';
      case 'maxHours': return 'maxHours';
      case 'maxConsecutive': return 'inARow';
      case 'minBlock': return 'blocks';
      case 'restAfterBlock': return 'offAfterBlock';
      case 'restAfterRun': return 'offAfterRun';
      case 'weekendFrequency': return 'weekends';
    }
  })();
  return KINDS.find(k => k.id === id)!;
}

/** Where a rule is listed. Hours limits written as "at most N hours" belong with hours and rest. */
export function groupOf(r: Rule): Kind['group'] {
  if (r.type === 'count' && r.unit === 'hours' && r.max !== undefined && !r.work.roleIds?.length && !r.work.categories?.length) return 'Hours and rest';
  return kindOf(r).group;
}

/** Common answers offered for each number, so most of the time you just click one. */
export const NUMBER_CHOICES: Record<string, number[]> = {
  amount: [1, 2, 3, 4, 5, 6, 8, 10],
  min: [1, 2, 3],
  hours: [8, 10, 11, 12, 24, 40, 46, 48, 60, 72],
  windowDays: [7, 14, 28],
  maxDays: [2, 3, 4, 5, 6, 7],
  minDays: [2, 3, 4],
  runDays: [2, 3, 4, 5, 7],
  maxWeekends: [1, 2, 3],
  inWeekends: [2, 3, 4, 5],
};

/** How each blank appears before it's filled in. */
export const PLACEHOLDERS: Record<string, string> = {
  who: 'who?', work: 'what?', a: 'what?', b: 'and what?', amount: 'how many?', min: 'how many?',
  hours: 'how many?', windowDays: 'how many?', maxDays: 'how many?', minDays: 'how many?', runDays: 'how many?',
  maxWeekends: 'how many?', inWeekends: 'how many?', period: 'how often?', lead: 'which consultant?', place: 'where?', shift0: 'which shift?', shift1: 'which shift?',
};
