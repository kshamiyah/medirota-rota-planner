import { isPersonWeek, parsePersonWeek, type PersonWeek } from './medirota';

/** A week counts as populated only when MediRota's By person parser accepts it. */
export function parseFetchedPersonWeek(status: number, html: string): PersonWeek | undefined {
  if (status !== 200 || !isPersonWeek(html)) return undefined;
  try {
    const week = parsePersonWeek(html);
    return week.people.length ? week : undefined;
  } catch {
    return undefined;
  }
}
