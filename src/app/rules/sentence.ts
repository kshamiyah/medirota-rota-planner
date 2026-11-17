/**
 * Every rule as a natural sentence made of plain text and "slots" (the parts
 * you can click to change). The rules list renders the slots as inline
 * controls; describeRule joins them into plain text. One template per kind of
 * rule, so what you read is exactly what you edit.
 */
import type { Profile, Rule } from '../../engine/types';
import { describeLeads, describeWho, describeWork } from './describe';

export type WorkKey = 'work' | 'a' | 'b';
export type NumKey = 'hours' | 'windowDays' | 'maxDays' | 'maxWeekends' | 'inWeekends' | 'amount' | 'min' | 'minDays' | 'runDays';
export type ChoiceKey = 'unit' | 'period' | 'direction' | 'bound';

export type Segment =
  | { t: 'text'; text: string; muted?: boolean }
  | { t: 'who'; emptyLabel?: string }
  | { t: 'work'; key: WorkKey; quiet?: boolean }
  | { t: 'days' }
  | { t: 'num'; key: NumKey; min?: number; step?: number }
  | { t: 'choice'; key: ChoiceKey; options: { value: string; label: string }[]; value: string }
  | { t: 'place' }
  | { t: 'shift'; index: 0 | 1 }
  | { t: 'lead' };

const DAY_PLURALS = ['Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays', 'Sundays'];

export function describeDays(weekdays: number[] | undefined): string {
  const wd = [...(weekdays ?? [])].sort();
  if (wd.length === 0 || wd.length === 7) return 'any day';
  if (wd.join() === '0,1,2,3,4') return 'weekdays';
  if (wd.join() === '5,6') return 'weekends';
  const names = wd.map(d => DAY_PLURALS[d]);
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

const isAnyWork = (w: { roleIds?: string[]; categories?: string[]; shiftTypeIds?: string[] } | undefined) =>
  !(w?.roleIds?.length || w?.categories?.length || w?.shiftTypeIds?.length);

export function hasDays(r: Rule): boolean {
  return r.type === 'forbid' || r.type === 'count' || r.type === 'notSameDay' || r.type === 'pairPreference' || r.type === 'linkShifts' || r.type === 'skillMix';
}

export function ruleSegments(r: Rule): Segment[] {
  const T = (text: string, muted = false): Segment => ({ t: 'text', text, muted });
  const must = r.hard && r.type !== 'preference' && r.type !== 'pairPreference';
  const can = must ? 'can' : 'should';
  switch (r.type) {
    case 'forbid':
      return [{ t: 'who' }, T(must ? " can't work" : ' should avoid'), { t: 'work', key: 'work' }];
    case 'count': {
      const n = r.min ?? r.max ?? 0;
      const target = r.min !== undefined;
      const unitOpts = [{ value: 'shifts', label: n === 1 ? 'shift' : 'shifts' }, { value: 'hours', label: n === 1 ? 'hour' : 'hours' }];
      const periodOpts = [
        { value: 'week', label: 'a week' }, { value: 'month', label: 'a month' },
        { value: 'horizon', label: 'over the whole rota' }, { value: 'avg', label: 'a week on average' },
      ];
      return [
        { t: 'who' },
        T(target ? (must ? ' must get' : ' should get') : (must ? ' can work' : ' should work')),
        { t: 'choice', key: 'bound', value: target ? 'min' : 'max', options: [{ value: 'max', label: 'at most' }, { value: 'min', label: 'at least' }] },
        { t: 'num', key: 'amount', step: r.unit === 'hours' ? 0.5 : 1 },
        { t: 'choice', key: 'unit', value: r.unit, options: unitOpts },
        T(' of', isAnyWork(r.work)), { t: 'work', key: 'work', quiet: isAnyWork(r.work) },
        { t: 'choice', key: 'period', value: r.perWeekAverage ? 'avg' : r.period, options: periodOpts },
      ];
    }
    case 'preference':
      return [{ t: 'who' }, T(' should get'), { t: 'choice', key: 'direction', value: r.direction, options: [{ value: 'more', label: 'more' }, { value: 'less', label: 'less' }] }, { t: 'work', key: 'work' }];
    case 'notSameDay':
      return [{ t: 'who', emptyLabel: 'No one' }, T(r.who && (r.who.groupIds?.length || r.who.staffIds?.length) ? (must ? " can't do" : ' should avoid doing') : (must ? ' does' : ' should do')),
        { t: 'work', key: 'a' }, T(' and'), { t: 'work', key: 'b' }, T(' on the same day')];
    case 'workWith':
      return [{ t: 'who' }, T(' should work with'), { t: 'lead' }, T(' on'), { t: 'work', key: 'work' }];
    case 'fewLeads':
      return [{ t: 'who' }, T(' should see as few different consultants as possible on'), { t: 'work', key: 'work' }];
    case 'share':
      return [{ t: 'who' }, T(' should share'), { t: 'work', key: 'work' }, T(' fairly, allowing for time off')];
    case 'pairPreference':
      return [{ t: 'who' }, T(' should do'), { t: 'work', key: 'a' }, T(' and'), { t: 'work', key: 'b' }, T(' on the same day where possible')];
    case 'linkShifts':
      return [T('The same person covers'), { t: 'place' }, T(' for both'), { t: 'shift', index: 0 }, T(' and'), { t: 'shift', index: 1 }];
    case 'minRest':
      return [{ t: 'who' }, T(must ? ' must have at least' : ' should have at least'), { t: 'num', key: 'hours' }, T(' hours off between shifts')];
    case 'maxHours':
      return [{ t: 'who' }, T(` ${can} work at most`), { t: 'num', key: 'hours' }, T(' hours in any'), { t: 'num', key: 'windowDays', min: 1 }, T(' days')];
    case 'maxConsecutive': {
      const onlyShifts = !(r.work.roleIds?.length || r.work.categories?.length) && !!r.work.shiftTypeIds?.length;
      return [{ t: 'who' }, T(` ${can} work at most`), { t: 'num', key: 'maxDays', min: 1 },
        ...(isAnyWork(r.work) ? [T(' days'), T(' of', true), { t: 'work', key: 'work', quiet: true } as Segment]
          : onlyShifts ? [{ t: 'work', key: 'work' } as Segment] : [T(' days of'), { t: 'work', key: 'work' } as Segment]),
        T(' in a row')];
    }
    case 'restAfterBlock':
      return [{ t: 'who' }, T(must ? ' must have' : ' should have'), { t: 'num', key: 'hours' }, T(' hours off after a run of'), { t: 'work', key: 'work' }];
    case 'skillMix':
      return [T('At least'), { t: 'num', key: 'min', min: 1 }, { t: 'who', emptyLabel: 'doctor(s)' }, T(' on'), { t: 'work', key: 'work' }, T(must ? ' every day' : ' every day where possible')];
    case 'minBlock':
      return [{ t: 'who' }, T(` ${must ? 'work' : 'should work'}`), { t: 'work', key: 'work' }, T(' in blocks of at least'), { t: 'num', key: 'minDays', min: 2 }];
    case 'restAfterRun':
      return [{ t: 'who' }, T(must ? ' must have at least' : ' should have at least'), { t: 'num', key: 'hours' }, T(' hours off after'), { t: 'num', key: 'runDays', min: 1 }, { t: 'work', key: 'work' }, T(' in a row')];
    case 'continuity':
      return [T('Keep the same doctor on'), { t: 'place' }, T(' for up to'), { t: 'num', key: 'runDays', min: 2 }, T(' days running')];
    case 'weekendFrequency':
      return [{ t: 'who' }, T(` ${can} work at most`), { t: 'num', key: 'maxWeekends' }, T(' in every'), { t: 'num', key: 'inWeekends', min: 1 }, T(' weekends')];
  }
}

export function numValue(r: Rule, key: NumKey): number {
  if (key === 'amount') return r.type === 'count' ? r.min ?? r.max ?? 0 : 0;
  return ((r as unknown as Record<string, number>)[key]) ?? 0;
}

/** Plain-text version of the sentence (also used as the rule's name). */
export function sentenceText(p: Profile, r: Rule): string {
  const roleName = (id: string) => p.roles.find(x => x.id === id)?.name ?? 'a removed place';
  const shiftName = (id: string) => p.shiftTypes.find(x => x.id === id)?.name ?? 'a removed shift';
  let out = '';
  for (const s of ruleSegments(r)) {
    switch (s.t) {
      case 'text': if (!s.muted) out += s.text; break;
      case 'who': {
        const who = describeWho(p, r.who);
        out += who === 'Everyone' && s.emptyLabel ? s.emptyLabel : who;
        break;
      }
      case 'work': if (!s.quiet) out += ' ' + describeWork(p, (r as unknown as Record<WorkKey, never>)[s.key]); break;
      case 'days': break;
      case 'num': out += ' ' + numValue(r, s.key); break;
      case 'choice': out += ' ' + (s.options.find(o => o.value === s.value)?.label ?? s.value); break;
      case 'place': out += ' ' + ('roleId' in r ? roleName(r.roleId) : ''); break;
      case 'shift': out += ' ' + (r.type === 'linkShifts' ? shiftName(r.shiftTypeIds[s.index]) : ''); break;
      case 'lead': out += ' ' + (r.type === 'workWith' ? describeLeads(p, r.leadIds) : ''); break;
    }
  }
  if (hasDays(r)) {
    const days = (r as { days?: { weekdays?: number[] } }).days?.weekdays;
    const d = describeDays(days);
    if (d !== 'any day') out += ` on ${d}`;
  }
  if (r.type === 'count' && r.scaleByFte) out += ' (less for part-timers)';
  if (r.type === 'share' && r.favour) out += ` ${favourText(p, r.favour)}`;
  return out.replace(/\s+/g, ' ').trim();
}

/** "with ST1 and ST2 getting 2× as much". */
export function favourText(p: Profile, f: { who: { groupIds?: string[]; staffIds?: string[] }; times: number }): string {
  return `with ${describeWho(p, f.who)} getting ${f.times}× as much`;
}

/** One plain-English sentence for a rule. */
export const describeRule = sentenceText;
