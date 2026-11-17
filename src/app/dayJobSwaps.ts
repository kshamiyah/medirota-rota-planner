import type { ISODate, Profile, Staff } from '../engine/types';
import { snapshotAssignments, type RotaSnapshot, type SwapSettings } from '../engine/swaps';
import { gradeForStaff, sessionForPlace, type SessionsSettings } from './sessions';
import type { ConsultantListCell } from './store';

export interface DayJobSwapPerson { staff: Staff; grade?: string; consultants: string[] }
export interface DayJobSwapGroup { placeId: string; placeName: string; people: DayJobSwapPerson[] }
export interface DayJobSwapResult { requesterPlaceName?: string; requesterPlaceId?: string; groups: DayJobSwapGroup[]; message?: string; count: number }

/** Short date used in messages, requester line and share text (e.g. "Thu 3 Dec"). */
export function dayJobShortDate(date: ISODate): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** Consultants matched to a staff/date/place cell, same source Fairer rota uses for lists. */
export function fairerMatchedConsultants(
  lists: { date: ISODate; placeId: string; staffIds: string[]; consultants: string[] }[], staffId: string, date: ISODate, placeId: string,
): string[] {
  return [...new Set(lists.filter(cell => cell.date === date && cell.placeId === placeId && cell.staffIds.includes(staffId))
    .flatMap(cell => cell.consultants.map(name => name.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'en-GB'));
}

function dayJobSubject(requester: Staff, viewerId?: string): { you: boolean; name: string } {
  const you = !viewerId || viewerId === requester.id;
  return { you, name: requester.name };
}

function notOnDayJobMessage(requester: Staff, date: ISODate, status: string | undefined, viewerId?: string): string {
  const short = dayJobShortDate(date);
  const { you, name } = dayJobSubject(requester, viewerId);
  const subject = you ? "You're" : `${name} is`;
  const your = you ? 'Your' : `${name}'s`;
  if (status === 'longDay') return `${subject} on a long day on ${short}. Use Cover my leave for long days.`;
  if (status === 'night') return `${subject} on a night shift on ${short}. Use Cover my leave for nights.`;
  if (status === 'partShift') return `${subject} on a part shift on ${short}. Day-job swaps need a whole-day job.`;
  if (status === 'dayJob') return `${your} activity is not a mapped whole-day job, so there are no day-job swaps to show.`;
  return `${subject} not on a day job on ${short}, so there are no day-job swaps to show.`;
}

export function findDayJobSwapOptions(input: {
  profile: Profile; snapshot: RotaSnapshot; sessions: SessionsSettings; settings: SwapSettings;
  consultantLists?: ConsultantListCell[]; requesterId: string; date: ISODate; viewerId?: string;
}): DayJobSwapResult {
  const { profile, snapshot, sessions, settings, requesterId, date, viewerId } = input;
  const read = snapshotAssignments(profile, snapshot, [date]);
  const roles = new Map(read.profile.roles.map(role => [role.id, role]));
  const staff = new Map(profile.staff.map(person => [person.id, person]));
  const placeFor = (staffId: string) => {
    const day = snapshot.days[staffId]?.[date];
    if (day?.status !== 'dayJob' || day.extra || staff.get(staffId)?.locum) return undefined;
    const assignments = read.assignments.filter(item => item.staffId === staffId);
    if (assignments.length !== 1) return undefined;
    const role = assignments[0].roleId ? roles.get(assignments[0].roleId) : undefined;
    const placeId = role?.parentId ?? role?.id;
    if (!placeId || !profile.roles.some(item => item.id === placeId && !item.parentId) || !sessionForPlace(sessions, placeId)) return undefined;
    return placeId;
  };
  const requesterPlaceId = placeFor(requesterId);
  const requester = staff.get(requesterId);
  if (!requester) return { groups: [], count: 0, message: 'Choose a doctor to see day-job swaps.' };
  if (!requesterPlaceId) {
    const status = snapshot.days[requesterId]?.[date]?.status;
    return { groups: [], count: 0, message: notOnDayJobMessage(requester, date, status, viewerId) };
  }
  const peopleByPlace = new Map<string, DayJobSwapPerson[]>();
  for (const person of profile.staff) {
    if (person.id === requesterId || person.locum || settings.excluded.some(item => item.staffId === person.id && (!item.until || date <= item.until))) continue;
    const placeId = placeFor(person.id);
    if (!placeId || placeId === requesterPlaceId) continue;
    const grade = gradeForStaff(person, profile);
    const consultants = fairerMatchedConsultants(input.consultantLists ?? [], person.id, date, placeId);
    peopleByPlace.set(placeId, [...(peopleByPlace.get(placeId) ?? []), { staff: person, grade, consultants }]);
  }
  const gradeOrder = new Map(profile.groups.map((group, index) => [group.name.trim().toLocaleLowerCase('en-GB'), index]));
  const orderedPlaceIds = [...new Set(sessions.types.flatMap(type => type.placeIds))];
  const placeOrder = new Map(orderedPlaceIds.map((placeId, index) => [placeId, index]));
  const comparePeople = (a: DayJobSwapPerson, b: DayJobSwapPerson) =>
    (gradeOrder.get(a.grade?.toLocaleLowerCase('en-GB') ?? '') ?? Number.MAX_SAFE_INTEGER) - (gradeOrder.get(b.grade?.toLocaleLowerCase('en-GB') ?? '') ?? Number.MAX_SAFE_INTEGER)
    || (a.grade ?? '').localeCompare(b.grade ?? '', 'en-GB') || a.staff.name.localeCompare(b.staff.name, 'en-GB');
  const placeName = (id: string) => profile.roles.find(role => role.id === id && !role.parentId)?.name ?? id;
  const groups = [...peopleByPlace.entries()].map(([placeId, people]) => ({ placeId, placeName: placeName(placeId), people: people.sort(comparePeople) }))
    .sort((a, b) => (placeOrder.get(a.placeId) ?? Number.MAX_SAFE_INTEGER) - (placeOrder.get(b.placeId) ?? Number.MAX_SAFE_INTEGER) || a.placeName.localeCompare(b.placeName, 'en-GB'));
  const count = groups.reduce((sum, group) => sum + group.people.length, 0);
  return { requesterPlaceId, requesterPlaceName: placeName(requesterPlaceId), groups, count, ...(count ? {} : { message: 'Nobody else is on a different day job that day.' }) };
}

export function dayJobSwapText(input: { date: string; requesterPlace: string; groups: DayJobSwapGroup[] }): string {
  const shortDate = dayJobShortDate(input.date);
  return [`Day job swap, ${shortDate}. I'm on ${input.requesterPlace}. Could anyone swap?`, ...input.groups.map(group => `*${group.placeName}*: ${group.people.map(person => person.staff.name).join(', ')}`)].join('\n\n');
}
