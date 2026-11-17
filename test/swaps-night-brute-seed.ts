/**
 * Fixed-seed night rota generator for brute-force parity checks (made-up names only).
 */
import { addDays } from '../src/engine/calendar';
import type { ISODate, Profile } from '../src/engine/types';
import type { RotaSnapshot, SwapRequest, SwapSettings } from '../src/engine/swaps';
import {
  STAGE2_MONDAY, applyDefaultLimitRules, blankSnapshot, mulberry32, off, setDay, stage2Profile, stage2Request, stage2Settings, work,
} from './swaps-stage2-helpers';

const ACTIVITIES = ['Night ward', 'Day clinic'];

function nightBlock(snapshot: RotaSnapshot, staffId: string, start: ISODate, length = 2) {
  for (let day = 0; day < length; day++) work(snapshot, staffId, addDays(start, day), 'night', 'Night ward');
}

function nameStaff(profile: Profile, ids: string[], labels: string[]) {
  for (let i = 0; i < ids.length; i++) profile.staff.find(s => s.id === ids[i])!.name = labels[i] ?? `Dr ${ids[i]}`;
}

export interface SeededNightRota {
  seed: number;
  profile: Profile;
  snapshot: RotaSnapshot;
  settings: SwapSettings;
  request: SwapRequest;
}

function directTwoPerson(): SeededNightRota {
  const ids = ['fig', 'grove'];
  const snapshot = blankSnapshot(ids);
  const profile = stage2Profile(ids, ACTIVITIES);
  applyDefaultLimitRules(profile);
  nameStaff(profile, ids, ['Dr Fig', 'Dr Grove']);
  const aStart = '2026-11-10';
  nightBlock(snapshot, 'fig', aStart);
  nightBlock(snapshot, 'grove', '2026-11-24');
  off(snapshot, 'grove', addDays(aStart, 0)); off(snapshot, 'grove', addDays(aStart, 1));
  off(snapshot, 'fig', '2026-11-24'); off(snapshot, 'fig', '2026-11-25');
  work(snapshot, 'grove', '2026-11-09', 'dayJob', 'Day clinic');
  off(snapshot, 'fig', '2026-11-09');
  work(snapshot, 'fig', '2026-11-23', 'dayJob', 'Day clinic');
  off(snapshot, 'grove', '2026-11-23');
  return { seed: 0, profile, snapshot, settings: stage2Settings(), request: stage2Request('fig', [aStart]) };
}

function fourPersonChain(): SeededNightRota {
  const decoys = Array.from({ length: 11 }, (_, index) => `hop-${String(index).padStart(2, '0')}`);
  const ids = ['fig', 'grove', 'heath', 'ivy', 'juniper', ...decoys];
  const snapshot = blankSnapshot(ids);
  const profile = stage2Profile(ids, ACTIVITIES);
  applyDefaultLimitRules(profile);
  nameStaff(profile, ['fig', 'grove', 'heath', 'ivy', 'juniper'], ['Dr Fig', 'Dr Grove', 'Dr Heath', 'Dr Ivy', 'Dr Juniper']);
  nightBlock(snapshot, 'fig', '2026-11-10');
  nightBlock(snapshot, 'grove', '2026-11-13');
  off(snapshot, 'grove', '2026-11-10'); off(snapshot, 'grove', '2026-11-11');
  off(snapshot, 'fig', '2026-11-13'); off(snapshot, 'fig', '2026-11-14');
  work(snapshot, 'grove', '2026-11-08', 'night', 'Night ward');
  nightBlock(snapshot, 'heath', '2026-11-17');
  nightBlock(snapshot, 'ivy', '2026-11-24');
  nightBlock(snapshot, 'juniper', '2026-12-01');
  off(snapshot, 'heath', '2026-11-10'); off(snapshot, 'heath', '2026-11-11');
  off(snapshot, 'ivy', '2026-11-17'); off(snapshot, 'ivy', '2026-11-18');
  off(snapshot, 'juniper', '2026-11-24'); off(snapshot, 'juniper', '2026-11-25');
  off(snapshot, 'fig', '2026-12-01'); off(snapshot, 'fig', '2026-12-02');
  work(snapshot, 'heath', '2026-11-09', 'dayJob', 'Day clinic'); off(snapshot, 'fig', '2026-11-09');
  work(snapshot, 'ivy', '2026-11-16', 'dayJob', 'Day clinic'); off(snapshot, 'heath', '2026-11-16');
  work(snapshot, 'juniper', '2026-11-23', 'dayJob', 'Day clinic'); off(snapshot, 'ivy', '2026-11-23');
  work(snapshot, 'fig', '2026-11-30', 'dayJob', 'Day clinic'); off(snapshot, 'juniper', '2026-11-30');
  for (const id of decoys) {
    nightBlock(snapshot, id, '2026-11-12');
    off(snapshot, id, '2026-11-24'); off(snapshot, id, '2026-11-25');
    snapshot.days[id]['2026-11-23'] = { status: 'training', activity: 'Teaching' };
  }
  off(snapshot, 'fig', '2026-11-12'); off(snapshot, 'fig', '2026-11-13');
  return { seed: 1, profile, snapshot, settings: stage2Settings({ maxChain: 4 }), request: stage2Request('fig', ['2026-11-10']) };
}

function threePersonChain(): SeededNightRota {
  const ids = ['fig', 'grove', 'heath'];
  const snapshot = blankSnapshot(ids, 12);
  const profile = stage2Profile(ids, ACTIVITIES);
  applyDefaultLimitRules(profile);
  nameStaff(profile, ids, ['Dr Fig', 'Dr Grove', 'Dr Heath']);
  const start = '2026-11-10';
  nightBlock(snapshot, 'fig', start);
  nightBlock(snapshot, 'grove', '2026-11-17');
  nightBlock(snapshot, 'heath', '2026-11-24');
  off(snapshot, 'grove', start); off(snapshot, 'grove', addDays(start, 1));
  off(snapshot, 'heath', '2026-11-17'); off(snapshot, 'heath', '2026-11-18');
  off(snapshot, 'fig', '2026-11-24'); off(snapshot, 'fig', '2026-11-25');
  work(snapshot, 'grove', '2026-11-09', 'dayJob', 'Day clinic'); off(snapshot, 'fig', '2026-11-09');
  work(snapshot, 'heath', '2026-11-16', 'dayJob', 'Day clinic'); off(snapshot, 'grove', '2026-11-16');
  work(snapshot, 'fig', '2026-11-23', 'dayJob', 'Day clinic'); off(snapshot, 'heath', '2026-11-23');
  return { seed: 2, profile, snapshot, settings: stage2Settings({ maxChain: 3 }), request: stage2Request('fig', [start]) };
}

function randomSeededNightRota(seed: number): SeededNightRota {
  const rand = mulberry32(10_000 + seed);
  const doctorCount = 4 + (seed % 4);
  const ids = ['req', ...Array.from({ length: doctorCount - 1 }, (_, i) => `doc-${String(i).padStart(2, '0')}`)];
  const withRules = seed % 4 !== 0;
  const profile = stage2Profile(ids, ACTIVITIES);
  if (withRules) applyDefaultLimitRules(profile);
  nameStaff(profile, ids, ['Dr Req', ...ids.slice(1).map((_, i) => `Dr Doc ${i + 1}`)]);
  const snapshot = blankSnapshot(ids, 12);
  const blockLen = 2;
  const clashStart = addDays(STAGE2_MONDAY, 2 + (seed % 12));
  nightBlock(snapshot, 'req', clashStart, blockLen);
  for (let i = 1; i < ids.length; i++) {
    const retStart = addDays(clashStart, 7 * i);
    nightBlock(snapshot, ids[i], retStart, blockLen);
    for (let d = 0; d < blockLen; d++) off(snapshot, ids[i], addDays(clashStart, d));
    for (let d = 0; d < blockLen; d++) off(snapshot, 'req', addDays(retStart, d));
  }
  const weeks = Object.keys(snapshot.importedAt).sort();
  for (const week of weeks) for (let d = 0; d < 7; d++) {
    const date = addDays(week as ISODate, d);
    for (const staffId of ids) {
      const existing = snapshot.days[staffId][date];
      if (existing.status !== 'blank') continue;
      const roll = rand();
      if (roll < 0.28) off(snapshot, staffId, date);
      else if (roll < 0.38) work(snapshot, staffId, date, 'dayJob', 'Day clinic');
      else if (roll < 0.42) setDay(snapshot, staffId, date, 'training', 'Teaching');
      else if (roll < 0.46) setDay(snapshot, staffId, date, 'leave', 'Study leave');
      else if (roll < 0.5) work(snapshot, staffId, date, 'night', 'Night ward');
    }
  }
  return {
    seed,
    profile,
    snapshot,
    settings: stage2Settings({ maxChain: 4 }),
    request: stage2Request('req', [clashStart]),
  };
}

export function buildSeededNightRota(seed: number): SeededNightRota {
  if (seed === 0) return directTwoPerson();
  if (seed === 1) return fourPersonChain();
  if (seed === 2) return threePersonChain();
  return randomSeededNightRota(seed);
}
