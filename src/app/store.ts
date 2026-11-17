/**
 * The workspace: one department profile plus the rota period being planned.
 * Saved to this browser automatically; export/import moves it between machines.
 */
import { useSyncExternalStore } from 'react';
import { dateRange, weekday } from '../engine/calendar';
import type { Assignment, FixedAssignment, ISODate, Profile, RotaProblem, Unavailability, Weekday } from '../engine/types';
import type { ReturnWindow, RotaSnapshot, SwapSettings } from '../engine/swaps';
export type { RotaSnapshot, SnapshotDay, SwapSettings, DayStatus as SwapDayStatus } from '../engine/swaps';
import type { StageReport } from '../engine/solve';
import type { SessionsSettings } from './sessions';

export interface StaffExtras {
  /** Part-time regular days off (0 = Monday). */
  nonWorkingWeekdays?: Weekday[];
}

export interface ConsultantListCell {
  date: ISODate;
  placeId: string;
  activity: string;
  session: string;
  staffIds: string[];
  consultants: string[];
  unmatched: number;
}

export interface SwapFinderData {
  settings: SwapSettings;
  snapshot: RotaSnapshot;
  recentSearches?: SwapRecentSearch[];
}

export interface SwapRecentSearch {
  staffId: string;
  leaveDates: ISODate[];
  leaveType: 'annual' | 'study';
  cantWorkDates: ISODate[];
  excludedStaffIds: string[];
  includeNormalDays: boolean;
  askMode: 'everyone' | 'only' | 'prefer';
  askStaffIds: string[];
  returnPattern: 'consecutive' | 'separate' | 'noPreference';
  returnDayType: 'noPreference' | 'weekdays' | 'weekends';
  returnWindow: ReturnWindow;
  noAlertsOnly: boolean;
  maxChain: number;
}

export interface Workspace {
  version: 1;
  profile: Profile;
  role?: 'doctor' | 'coordinator';
  /** Doctor selected for personal overview context, retained with this workspace. */
  me?: string;
  /** Session categories, grade comparisons and weighting used by Sessions. */
  sessions?: SessionsSettings;
  /** Matched By activity lists used only by Fairer rota consultant planning. */
  consultantLists?: ConsultantListCell[];
  /** Per-person consultant pairs selected in Same consultants settings. */
  consultantPairs?: Record<string, string[]>;
  /** Manual placement for ambiguous grades in split comparison groups. */
  sessionSubGroups?: Record<string, string>;
  /** Last Fairer rota controls, saved with this workspace. */
  fairerSettings?: { start: ISODate; end: ISODate; changeLimit: number | 'none'; lastLimitedPercent?: number; maxDays: 2 | 3 | 4 | 'none'; keepSameConsultants?: boolean };
  /** Per-person extras the engine doesn't need directly. */
  staffExtras: Record<string, StaffExtras>;
  period: { start: ISODate; end: ISODate };
  unavailability: Unavailability[];
  fixed: FixedAssignment[];
  /** Swap finder data is separate from the planner's rota, bookings and leave. */
  swapFinder?: SwapFinderData;
  /** What each MediRota activity became last time, so imports remember the choices. */
  medirotaFetch?: { trustedOrigins: string[]; lastEndWeek?: ISODate };
  /** Local setup defaults retained by name so later imports can apply them. */
  presetPeople?: {
    people: { name: string; excludeFromSwaps?: boolean; regularDaysOff?: number[]; fte?: number; locum?: boolean; regularLocum?: boolean; sessionSubGroup?: string; consultants?: string[] }[];
    manualOverrides: Record<string, { excludeFromSwaps?: boolean; regularDaysOff?: number[]; fte?: number; locum?: boolean; regularLocum?: boolean; sessionSubGroup?: string; consultants?: string[] }>;
    me?: string;
  };
  mediRota?: {
    activities: Record<string, { treat: 'night' | 'long' | 'dayjob' | 'leave' | 'training' | 'zero' | 'unavailable' | 'ignore'; placeId?: string }>;
    /** MediRota bookings chosen to be left out, as "mediRotaId|date", so importing again doesn't bring them back. */
    skip?: string[];
  };
  rota?: {
    assignments: Assignment[];
    stages: StageReport[];
    seconds: number;
    createdAt: string;
    /** Set when the rota was edited by hand after it was made. */
    edited?: boolean;
    /** Assignments to keep exactly as they are when the rota is made again. */
    locked?: string[];
  };
}

export const WORKSPACE_STORAGE_KEY = 'rota-planner.workspace.v1';
const KEY = WORKSPACE_STORAGE_KEY;
const REV_KEY = 'rota-planner.workspace.rev.v1';

export function emptyProfile(): Profile {
  return { name: 'My department', shiftTypes: [], roles: [], groups: [], staff: [], demands: [], rules: [], fairness: defaultFairness() };
}

export function defaultFairness(): Profile['fairness'] {
  return [
    { id: 'hours', name: 'Total hours', unit: 'hours', weight: 1 },
    { id: 'weekends', name: 'Weekend shifts', weekendsOnly: true, unit: 'shifts', weight: 2 },
  ];
}

function nextMonday(): ISODate {
  const d = new Date();
  const wd = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() + (7 - wd));
  return d.toISOString().slice(0, 10);
}

export function emptyWorkspace(): Workspace {
  const start = nextMonday();
  const end = addDaysLocal(start, 6);
  return { version: 1, profile: emptyProfile(), staffExtras: {}, period: { start, end }, unavailability: [], fixed: [] };
}

function addDaysLocal(d: ISODate, n: number): ISODate {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

function parseStoredWorkspace(raw: string | null): Workspace | undefined {
  if (!raw) return undefined;
  try {
    const ws = JSON.parse(raw) as Workspace;
    if (ws && ws.version === 1 && ws.profile) return { ...emptyWorkspace(), ...ws };
  } catch {
    // Corrupt storage: ignore.
  }
  return undefined;
}

function readStoredRevision(): number {
  try {
    const value = Number(localStorage.getItem(REV_KEY) ?? '0');
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

function load(): Workspace {
  try {
    const stored = parseStoredWorkspace(localStorage.getItem(KEY));
    if (stored) return stored;
  } catch {
    // Storage unavailable or corrupt: start fresh.
  }
  return emptyWorkspace();
}

let state: Workspace = load();
let revision = readStoredRevision();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach(listener => listener());
}

function save(): void {
  try {
    const nextRev = Math.max(readStoredRevision(), revision) + 1;
    localStorage.setItem(KEY, JSON.stringify(state));
    localStorage.setItem(REV_KEY, String(nextRev));
    revision = nextRev;
  } catch {
    // Private mode or full storage: keep working in memory; leave revision unchanged.
  }
}

/** Pull a newer workspace saved by another tab. Returns true when local state changed. */
export function adoptWorkspaceFromStorage(): boolean {
  try {
    const storedRev = readStoredRevision();
    // Only a newer revision counts. Content-only diffs must not win: a failed save
    // leaves an older stored copy that must not wipe in-memory edits.
    if (storedRev <= revision) return false;
    const stored = parseStoredWorkspace(localStorage.getItem(KEY));
    if (!stored) return false;
    state = stored;
    revision = storedRev;
    notify();
    return true;
  } catch {
    return false;
  }
}

/** Test helper: write as another tab would, without updating this tab's in-memory state. */
export function writeWorkspaceAsOtherTab(ws: Workspace): void {
  const next = { ...emptyWorkspace(), ...ws };
  const nextRev = Math.max(readStoredRevision(), revision) + 1;
  localStorage.setItem(KEY, JSON.stringify(next));
  localStorage.setItem(REV_KEY, String(nextRev));
}

export function getWorkspace(): Workspace {
  return state;
}

export function getWorkspaceRevision(): number {
  return revision;
}

export function hasSavedWorkspace(): boolean {
  try { return localStorage.getItem(KEY) !== null; } catch { return false; }
}

/** Apply a change. The mutator edits a copy, so React sees a new object. */
export function update(mutate: (draft: Workspace) => void): void {
  adoptWorkspaceFromStorage();
  const draft = structuredClone(state);
  mutate(draft);
  state = draft;
  save();
  notify();
}

export function replaceWorkspace(ws: Workspace): void {
  adoptWorkspaceFromStorage();
  state = { ...emptyWorkspace(), ...ws };
  save();
  notify();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (event.key !== KEY && event.key !== REV_KEY && event.key !== null) return;
    adoptWorkspaceFromStorage();
  });
}

export function useWorkspace(): Workspace {
  return useSyncExternalStore(
    cb => { listeners.add(cb); return () => listeners.delete(cb); },
    () => state,
  );
}

export function newId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

/** The engine's view of the workspace for the current period. */
export function toProblem(ws: Workspace): RotaProblem {
  const dates = dateRange(ws.period.start, ws.period.end);
  const unavailability = ws.unavailability.filter(u => u.date >= ws.period.start && u.date <= ws.period.end);
  for (const s of ws.profile.staff) {
    const days = ws.staffExtras[s.id]?.nonWorkingWeekdays ?? [];
    if (days.length === 0) continue;
    for (const d of dates) {
      if (days.includes(weekday(d)) && !unavailability.some(u => u.staffId === s.id && u.date === d && !u.shiftTypeIds)) {
        unavailability.push({ staffId: s.id, date: d, kind: 'nonWorking', reason: 'Regular day off' });
      }
    }
  }
  const fixed = ws.fixed.filter(f => f.date >= ws.period.start && f.date <= ws.period.end);
  const locked = new Set(ws.rota?.locked ?? []);
  for (const a of ws.rota?.assignments ?? []) {
    if (!a.fixed && locked.has(assignmentKey(a))) fixed.push({ staffId: a.staffId, date: a.date, shiftTypeId: a.shiftTypeId, roleId: a.roleId, reason: 'Locked' });
  }
  return { profile: ws.profile, start: ws.period.start, end: ws.period.end, unavailability, fixed };
}

export function assignmentKey(a: { staffId: string; date: string; shiftTypeId: string; roleId?: string }): string {
  return `${a.staffId}|${a.date}|${a.shiftTypeId}|${a.roleId ?? '-'}`;
}

export function exportWorkspace(): void {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.profile.name.replace(/[^\w-]+/g, '-').toLowerCase() || 'rota'}.rota.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export async function importWorkspace(file: File): Promise<void> {
  const ws = JSON.parse(await file.text()) as Workspace;
  if (!ws || ws.version !== 1 || !ws.profile) throw new Error('This file is not a Rota Planner workspace.');
  replaceWorkspace(ws);
}
