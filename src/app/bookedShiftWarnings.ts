import type { Profile } from '../engine/types';
import type { RotaSnapshot } from '../engine/swaps';

export interface BookedShiftWarning { placeId: string; activity: string; kind: 'booked night' | 'booked long day' }

/** Booked night and long-day activities, keyed back to their stable place ids. */
export function bookedShiftWarnings(profile: Profile, snapshot?: RotaSnapshot): BookedShiftWarning[] {
  const unique = new Map<string, BookedShiftWarning>();
  for (const days of Object.values(snapshot?.days ?? {})) for (const day of Object.values(days)) {
    if (!day.activity || (day.status !== 'night' && day.status !== 'longDay')) continue;
    const role = profile.roles.find(item => item.name.toLocaleLowerCase('en-GB') === day.activity!.toLocaleLowerCase('en-GB'));
    if (!role) continue;
    const placeId = role.parentId ?? role.id;
    const kind = day.status === 'night' ? 'booked night' : 'booked long day';
    unique.set(`${placeId}|${day.activity}|${kind}`, { placeId, activity: day.activity, kind });
  }
  return [...unique.values()];
}
