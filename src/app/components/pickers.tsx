import type { Profile, StaffSelector, WorkSelector } from '../../engine/types';
import { describeWho, describeWork } from '../rules/describe';
import { describeDays } from '../rules/sentence';
import { MultiSelect } from './MultiSelect';

/** Who a rule applies to: groups and/or named people. Nothing picked = everyone. */
export function WhoSelect({ profile: p, value, onChange, inline, emptyLabel, unset, onClose }: { profile: Profile; value: StaffSelector | undefined; onChange: (v: StaffSelector) => void; inline?: boolean; emptyLabel?: string; unset?: boolean; onClose?: () => void }) {
  const v = value ?? {};
  return (
    <MultiSelect label="Who" inline={inline} unset={unset} onClose={onClose} summary={describeWho(p, v) === 'Everyone' && emptyLabel ? emptyLabel : describeWho(p, v)} clearLabel="Everyone" onClear={() => onChange({})}
      sections={[
        { title: 'Groups', options: p.groups.map(g => ({ value: g.id, label: g.name })), value: v.groupIds, onChange: groupIds => onChange({ ...v, groupIds }) },
        { title: 'People', options: p.staff.map(s => ({ value: s.id, label: s.name })), value: v.staffIds, onChange: staffIds => onChange({ ...v, staffIds }) },
      ]} />
  );
}

/** Which work a rule looks at: places, groups of places and/or shifts. Nothing picked = any work. */
export function WorkSelect({ profile: p, value, onChange, label = 'What work', inline, muted, unset, onClose }: { profile: Profile; value: WorkSelector | undefined; onChange: (v: WorkSelector) => void; label?: string; inline?: boolean; muted?: boolean; unset?: boolean; onClose?: () => void }) {
  const v = value ?? {};
  const categories = [...new Set(p.roles.map(r => r.category).filter((c): c is string => !!c))];
  return (
    <MultiSelect label={label} inline={inline} muted={muted} unset={unset} onClose={onClose} summary={describeWork(p, v)} clearLabel="Any work" onClear={() => onChange({})}
      sections={[
        { title: 'Groups of places', options: categories.map(c => ({ value: c, label: `Any ${c}` })), value: v.categories, onChange: categories => onChange({ ...v, categories }) },
        { title: 'Places', options: p.roles.filter(r => !r.parentId).map(r => ({ value: r.id, label: r.name })), value: v.roleIds, onChange: roleIds => onChange({ ...v, roleIds }) },
        { title: 'Only on these shifts', options: p.shiftTypes.map(s => ({ value: s.id, label: s.name })), value: v.shiftTypeIds, onChange: shiftTypeIds => onChange({ ...v, shiftTypeIds }) },
      ]} />
  );
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Which days: nothing picked = every day. */
export function DaysSelect({ value, onChange, inline, unset, onClose }: { value: number[] | undefined; onChange: (v: (0 | 1 | 2 | 3 | 4 | 5 | 6)[]) => void; inline?: boolean; unset?: boolean; onClose?: () => void }) {
  const v = [...(value ?? [])].sort();
  const any = v.length === 0 || v.length === 7;
  const summary = inline ? `on ${describeDays(v)}` : any ? 'every day' : v.join() === '0,1,2,3,4' ? 'on weekdays' : v.join() === '5,6' ? 'at weekends' : `on ${v.map(d => DAY_NAMES[d]).join(', ')}`;
  return (
    <MultiSelect label="Which days" inline={inline} unset={unset} onClose={onClose} muted={inline && any && !unset} summary={summary} clearLabel="Every day" onClear={() => onChange([])}
      sections={[{ title: 'Only on', options: DAY_NAMES.map((d, i) => ({ value: String(i), label: d })), value: v.map(String), onChange: x => onChange(x.map(Number) as (0 | 1 | 2 | 3 | 4 | 5 | 6)[]) }]} />
  );
}
