/**
 * Reading MediRota pages saved from the browser ("Save page as…").
 *
 * The "By activity" week view has one row per activity (Elective C-Sections,
 * MAU CT…) with, for each day and session, the juniors booked and the senior
 * rota mapped onto it ("WS Cons: Hart, Morgan (Cons Gyn)"). From that we
 * learn which consultant runs each list on each day.
 */
import type { Demand, ISODate, Role } from '../engine/types';
import { demandFor } from '../engine/semantics';
import { newId, type Workspace } from './store';

export interface ActivityDay {
  /** Most juniors booked (or slots left open) in any one session that day. */
  juniors: number;
  /** Consultants mapped onto the activity that day, as "First Last". */
  consultants: string[];
  /** The individual By activity cells, retained for consultant allocation. */
  cells?: ActivitySessionCell[];
}

export interface ActivityJunior { mediRotaId?: string; name: string }
export interface ActivitySessionCell { date: ISODate; session: string; juniors: ActivityJunior[]; consultants: string[] }

export interface ActivityRow {
  name: string;
  description: string;
  days: Record<ISODate, ActivityDay>;
}

export interface ActivityWeek {
  start: ISODate;
  activities: ActivityRow[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×' };
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
const text = (s: string) => decode(s.replace(/<a [^>]*>[\s\S]*?<\/a>/g, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** MediRota slot headings (`rmap-rota__slottitle`) are labels above a cell, never activities. */
function isSlotTitleLi(liHtml: string): boolean {
  return /rmap-rota__slottitle/.test(liHtml);
}

/** True when a place/activity name is only an ellipsis (MediRota heading residue). */
export function isEllipsisOnlyName(name: string): boolean {
  const n = name.trim();
  return n === '…' || n === '...' || n.toLowerCase() === '&hellip;';
}

/** "Hart, Morgan" → "Morgan Hart"; other forms are kept as written. */
function tidyName(raw: string): string {
  const n = raw.replace(/\s+/g, ' ').replace(/[.,\s]+$/, '').trim();
  const m = n.match(/^([^,]+),\s*(.+)$/);
  return m ? `${m[2].trim()} ${m[1].trim()}` : n;
}

/** Consultants named in a mapping tooltip: anyone shown with "(Cons …)". */
function consultantsIn(tooltip: string): string[] {
  const out = new Set<string>();
  for (const part of decode(tooltip).split(/<[^>]+>|\n/)) {
    const m = text(part).match(/([A-Z][A-Za-z'\-]+(?:[ ,]+[A-Z][A-Za-z'\-.]+)+)\s*\(Cons\b/);
    if (m) out.add(tidyName(m[1]));
  }
  return [...out];
}

export function isActivityWeek(html: string): boolean {
  return /<div id ?="activity-\d+" class="activity-container/.test(html);
}

export function parseActivityWeek(html: string): ActivityWeek {
  const start = html.match(/data-rota-date="(\d{4}-\d{2}-\d{2})"/)?.[1];
  if (!start || !isActivityWeek(html)) throw new Error('This doesn\'t look like a MediRota "By activity" week. Open Rota → By activity in MediRota, then save the page.');
  const starts = [...html.matchAll(/<div id ?="activity-\d+" class="activity-container[^"]*"/g)];
  const activities: ActivityRow[] = [];
  starts.forEach((m, i) => {
    const chunk = html.slice(m.index! + m[0].length, i + 1 < starts.length ? starts[i + 1].index : html.length);
    const name = text(chunk.match(/rmap-rota__detail-name">([\s\S]*?)<\/span>/)?.[1] ?? '');
    if (!name) return;
    const head = text(chunk.match(/js-activity-name">([\s\S]*?)<\/div>/)?.[1] ?? '');
    const days: Record<ISODate, ActivityDay> = {};
    for (const row of chunk.split('<td class="rmap-rota__session-label">').slice(1)) {
      const session = text(row.split('</td>')[0] ?? '');
      const rowHtml = row.slice(row.indexOf('</td>') + 5).split('</tr>')[0] ?? '';
      for (const c of rowHtml.matchAll(/<td\b[^>]*data-slot_date="(\d{4}-\d{2}-\d{2})"[^>]*>([\s\S]*?)<\/td>/g)) {
        const [, date, cellHtml] = c;
        const ul = cellHtml.match(/<ul class="rmap-rota__assigned[^"]*">([\s\S]*?)<\/ul>/)?.[1] ?? '';
        const juniors = [...ul.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)].filter(x => !isSlotTitleLi(x[0])).map(x => {
          const name = text(x[2]).replace(/^×\s*/, '').trim();
          const id = x[1].match(/data-person-id="([^"]+)"/)?.[1];
          return name && name !== '[Away]' ? { ...(id ? { mediRotaId: id } : {}), name } : undefined;
        }).filter((junior): junior is ActivityJunior => !!junior);
        const cons = [...cellHtml.matchAll(/class="mapping" data-tooltip="([\s\S]*?)">/g)].flatMap(t => consultantsIn(t[1]));
        const day = days[date] ?? (days[date] = { juniors: 0, consultants: [], cells: [] });
        day.juniors = Math.max(day.juniors, juniors.length);
        for (const x of cons) if (!day.consultants.includes(x)) day.consultants.push(x);
        day.cells!.push({ date: date as ISODate, session, juniors, consultants: [...new Set(cons)] });
      }
    }
    activities.push({ name, description: head.replace(name, '').trim(), days });
  });
  return { start, activities };
}

const norm = (s: string) => s.toLowerCase().replace(/\bct\b/g, '').replace(/[^a-z0-9]/g, '');

/** Activities that have consultants and juniors on at least one day: the ones worth importing. */
export function importable(weeks: ActivityWeek[]): { withJuniors: string[]; seniorsOnly: string[] } {
  const seen = new Map<string, { cons: boolean; juniors: boolean }>();
  for (const w of weeks) for (const a of w.activities) {
    const s = seen.get(a.name) ?? { cons: false, juniors: false };
    for (const d of Object.values(a.days)) { if (d.consultants.length) s.cons = true; if (d.juniors) s.juniors = true; }
    seen.set(a.name, s);
  }
  const withCons = [...seen].filter(([, s]) => s.cons);
  return { withJuniors: withCons.filter(([, s]) => s.juniors).map(([n]) => n), seniorsOnly: withCons.filter(([, s]) => !s.juniors).map(([n]) => n) };
}

/** The place an activity most likely is: same name, ignoring case, punctuation and "CT". */
export function guessPlace(roles: Role[], activity: string): string | undefined {
  const a = norm(activity);
  return roles.find(r => !r.parentId && norm(r.name) === a)?.id;
}

export interface ImportResult {
  consultantsAdded: string[];
  listsCreated: string[];
  days: number;
}

/**
 * Turn the consultants found in MediRota weeks into consultant lists: for
 * each day an activity has consultants, the place's usual need is replaced
 * that day by a need on the list run by those consultants. Importing the same
 * week again replaces what it set before.
 */
export function applyConsultantLists(w: Workspace, weeks: ActivityWeek[], placeFor: Record<string, string>): ImportResult {
  const p = w.profile;
  p.leads = p.leads ?? [];
  const result: ImportResult = { consultantsAdded: [], listsCreated: [], days: 0 };
  const leadId = (name: string) => {
    let l = p.leads!.find(x => x.name.toLowerCase() === name.toLowerCase());
    if (!l) { l = { id: newId('cons'), name }; p.leads!.push(l); result.consultantsAdded.push(name); }
    return l.id;
  };
  // Gather every list for each place and day first, so two activities matched
  // to the same place add up instead of one replacing the other.
  const plan = new Map<string, { place: Role; shiftTypeId: string; date: ISODate; lists: Map<string, number> }>();
  for (const week of weeks) for (const act of week.activities) {
    const place = p.roles.find(r => r.id === placeFor[act.name]);
    if (!place) continue;
    const shiftTypeId = p.demands.find(d => d.roleId === place.id)?.shiftTypeId ?? p.shiftTypes[0]?.id;
    if (!shiftTypeId) continue;
    for (const [date, day] of Object.entries(act.days)) {
      // A day with no junior booked on it needs no junior from this activity.
      if (day.consultants.length === 0 || day.juniors === 0) continue;
      const leads = day.consultants.map(leadId).sort();
      let list = p.roles.find(r => r.parentId === place.id && (r.leadIds ?? []).slice().sort().join() === leads.join());
      if (!list) {
        const names = leads.map(id => p.leads!.find(l => l.id === id)!.name);
        list = { id: newId('list'), name: `${place.name} – ${names.join(' & ')}`, parentId: place.id, leadIds: leads };
        p.roles.push(list);
        result.listsCreated.push(list.name);
      }
      const key = `${place.id}|${date}`;
      const entry = plan.get(key) ?? { place, shiftTypeId, date, lists: new Map<string, number>() };
      entry.lists.set(list.id, (entry.lists.get(list.id) ?? 0) + day.juniors);
      plan.set(key, entry);
    }
  }
  for (const { place, shiftTypeId, date, lists } of plan.values()) {
    const usual = demandFor({ ...p, demands: p.demands.filter(d => !(d.days.dates?.includes(date))) }, place.id, shiftTypeId, date);
    const ofPlace = new Set(p.roles.filter(r => r.parentId === place.id).map(r => r.id));
    // Replace whatever an earlier import set for this place on this day.
    p.demands = p.demands.filter(d => !(d.source === 'medirota' && d.days.dates?.length === 1 && d.days.dates[0] === date && (d.roleId === place.id || ofPlace.has(d.roleId))));
    const one = (roleId: string, n: number): Demand => ({ id: newId('need'), roleId, shiftTypeId, days: { dates: [date] }, min: n, max: n, importance: usual.importance > 1 ? usual.importance : undefined, source: 'medirota' });
    p.demands.push(one(place.id, 0));
    for (const [listId, n] of lists) p.demands.push(one(listId, n));
    result.days++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// "By person" weeks: each doctor's row with what they do in each session.

export type Session = 'am' | 'pm' | 'eve' | 'night';
const SESSIONS: Record<string, Session> = { '1': 'am', '2': 'pm', '3': 'eve', '4': 'night' };

export interface PersonRow {
  /** MediRota's own id for the person, stable across weeks. */
  id: string;
  /** As MediRota shows it in the row, e.g. "Rowan, Ellis". */
  rowName: string;
  /** From the people list, e.g. "Ellis Rowan (ST2)", when the page has one. */
  label?: string;
  /** The rota role under the name, e.g. "CT" or "Locum". */
  role: string;
  /** Activities per date and session, e.g. { "2026-11-02": { night: ["Nights CT"] } }. */
  days: Record<ISODate, Partial<Record<Session, string[]>>>;
}

export interface PersonWeek {
  start: ISODate;
  people: PersonRow[];
}

export function isPersonWeek(html: string): boolean {
  return /js-main-rota[^"]*" data-person="\d+"/.test(html);
}

export function parsePersonWeek(html: string): PersonWeek {
  const tables = [...html.matchAll(/<table class="rmap-table[^"]*js-main-rota[^"]*" data-person="(\d+)"[^>]*data-rota-date="(\d{4}-\d{2}-\d{2})"/g)];
  if (!tables.length) throw new Error('This doesn\'t look like a MediRota "By person" week. Open Rota → By person in MediRota, then save the page.');
  const labels = new Map<string, string>();
  for (const m of html.matchAll(/<option value="person-(\d+)"\s*>\s*([\s\S]*?)\s*<\/option>/g)) labels.set(m[1], text(m[2]));
  const people: PersonRow[] = [];
  tables.forEach((m, i) => {
    const chunk = html.slice(m.index! + m[0].length, i + 1 < tables.length ? tables[i + 1].index : html.length);
    const rowName = text(chunk.match(/rmap-rota__detail-name">([\s\S]*?)<\/span>/)?.[1] ?? '');
    const detail = text(chunk.match(/js-activity-name">([\s\S]*?)<\/div>/)?.[1] ?? '');
    // The role is the first word after the name; anything after (a phone number) is ignored.
    const role = detail.replace(rowName, '').trim().split(/\s+/)[0] ?? '';
    const days: PersonRow['days'] = {};
    for (const c of chunk.matchAll(/<td id="n-[^"]*" class="[^"]*person-slot"[^>]*data-date="(\d{4}-\d{2}-\d{2})" data-shift_id="(\d+)"[^>]*>([\s\S]*?)<\/td>(?=\s*(?:<td id="n-|<\/tr>))/g)) {
      const session = SESSIONS[c[2]];
      if (!session) continue;
      const acts = [...c[3].matchAll(/<li[^>]*>([\s\S]*?)<\/li>/g)].filter(x => !isSlotTitleLi(x[0])).map(x => text(x[1])).filter(Boolean);
      if (!acts.length) continue;
      (days[c[1]] ??= {})[session] = acts;
    }
    people.push({ id: m[1], rowName, label: labels.get(m[1]), role, days });
  });
  return { start: tables[0][2], people };
}

/** Times written in an activity's note, e.g. "0800-1730. Eve = 0800-2030" → day 08:00–17:30, long day 08:00–20:30. */
export function timesInNote(note: string): { day?: [string, string]; long?: [string, string] } {
  const t = (s: string) => `${s.slice(0, 2)}:${s.slice(2)}`;
  const day = note.match(/\b(\d{4})\s*-\s*(\d{4})\b/);
  const long = note.match(/Eve\s*=\s*(\d{4})\s*-\s*(\d{4})/i);
  return { ...(day ? { day: [t(day[1]), t(day[2])] as [string, string] } : {}), ...(long ? { long: [t(long[1]), t(long[2])] as [string, string] } : {}) };
}
