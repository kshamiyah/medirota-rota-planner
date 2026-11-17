/**
 * Copy strings as shown in the browser (Chromium en-GB inserts a comma after the weekday).
 * Node's ICU omits it; do not use src/app formatDateLong for Playwright exact-text checks.
 */
import type { MovedShift } from '../src/engine/swaps';
import type { Staff } from '../src/engine/types';

function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

export function formatDateLongForUi(iso: string): string {
  const plain = new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  return plain.replace(/^(\w{3}) (\d)/, '$1, $2');
}

export function movedShiftSentenceForUi(move: MovedShift, staff: Staff[], requesterId: string): string {
  const name = (id: string) => staff.find(person => person.id === id)?.name ?? 'Unknown doctor';
  const recipient = move.toStaffId === requesterId ? 'You' : name(move.toStaffId);
  const owner = move.fromStaffId === requesterId ? 'your' : possessive(name(move.fromStaffId));
  return `${recipient} also ${move.toStaffId === requesterId ? 'take' : 'takes'} ${owner} ${move.activity || (move.kind === 'longDay' ? 'long day' : 'day shift')} on ${formatDateLongForUi(move.date)}.`;
}
