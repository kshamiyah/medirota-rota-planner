/**
 * Data model for a department profile and a rota problem.
 *
 * Everything a department needs is expressed as data here: no department-specific
 * names or rules live in engine code. The front end edits these objects; the
 * engine reads them.
 */

export type Id = string;
/** Calendar date, YYYY-MM-DD. Times are wall-clock; DST shifts are ignored. */
export type ISODate = string;
/** 0 = Monday … 6 = Sunday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface ShiftType {
  id: Id;
  name: string;
  /** "HH:MM" */
  start: string;
  /** "HH:MM". An end at or before the start means the shift finishes the next day. */
  end: string;
  /** Hours counted towards workload. Defaults to the shift's duration. */
  hours?: number;
}

export interface Role {
  id: Id;
  name: string;
  /** Free-text grouping used by rules and reports, e.g. "Theatre", "Wards". */
  category?: string;
  /**
   * A consultant's list within a place (e.g. Elective C-Sections with Mr X).
   * Rules about the parent place also apply to its lists.
   */
  parentId?: Id;
  /** The consultants running this list. */
  leadIds?: Id[];
}

/** A senior (e.g. a consultant) who runs lists that juniors work on. */
export interface Lead {
  id: Id;
  name: string;
}

export interface Group {
  id: Id;
  name: string;
}

export interface Staff {
  id: Id;
  name: string;
  groupIds: Id[];
  /** Whole-time equivalent, 0–1. Used to scale fairness and any rule marked scaleByFte. */
  fte: number;
  /** First and last day in the department (inclusive). Dates outside count as away. */
  startDate?: ISODate;
  endDate?: ISODate;
  /**
   * A locum or bank doctor: only works shifts already booked for them (they
   * apply for shifts separately), and is left out of fairness.
   */
  locum?: boolean;
  /** A regular locum committed to the department, displayed alongside rota doctors. */
  regularLocum?: boolean;
  /** MediRota's id for this person, so later imports always match them. */
  mediRotaId?: string;
}

/** Which people a rule applies to. Empty or omitted fields mean "everyone". */
export interface StaffSelector {
  staffIds?: Id[];
  groupIds?: Id[];
}

/** Which work a rule looks at. Fields are combined with AND; omitted means "any". */
export interface WorkSelector {
  roleIds?: Id[];
  categories?: string[];
  shiftTypeIds?: Id[];
}

/** Which dates a rule or demand covers. Omitted fields mean "every day". */
export interface DaySelector {
  weekdays?: Weekday[];
  dates?: ISODate[];
  excludeDates?: ISODate[];
}

/** How many people a role needs on a shift. */
export interface Demand {
  id: Id;
  roleId: Id;
  shiftTypeId: Id;
  days: DaySelector;
  min: number;
  max: number;
  /** Relative importance of filling the minimum. Default 1. */
  importance?: number;
  /** Set when the need came from an import (e.g. a consultant's list from MediRota). */
  source?: 'medirota';
}

export interface Unavailability {
  staffId: Id;
  date: ISODate;
  /** Omitted means the whole day. */
  shiftTypeIds?: Id[];
  /**
   * 'nonWorking' is a part-time doctor's regular day off, already reflected in
   * their FTE, so it doesn't reduce their fair share further. 'leave' (default)
   * and 'other' do.
   */
  kind?: 'leave' | 'nonWorking' | 'other';
  /** Set when it came from a MediRota import, so importing again replaces it. */
  source?: 'medirota';
  reason?: string;
}

/**
 * A shift that is already decided. With a roleId from the profile it counts
 * towards that role's cover; without one it is an outside commitment that still
 * occupies time and counts towards hours and rest rules.
 */
export interface FixedAssignment {
  staffId: Id;
  date: ISODate;
  shiftTypeId: Id;
  roleId?: Id;
  reason?: string;
  /** Set when it came from a MediRota import, so importing again replaces it. */
  source?: 'medirota';
}

/** Soft rules are optimised in tiers, highest first. */
export type Tier = 'coverage' | 'training' | 'fairness' | 'paired' | 'consultants' | 'preference' | 'extra';
export const DEFAULT_TIER_ORDER: Tier[] = ['coverage', 'training', 'fairness', 'preference', 'extra'];

export type Period = 'week' | 'month' | 'horizon';

interface RuleBase {
  id: Id;
  name: string;
  enabled?: boolean;
  /** Hard rules are never broken. Soft rules are penalised in their tier. */
  hard: boolean;
  /** Tier for soft rules. Ignored for hard rules. */
  tier?: Tier;
  /** Multiplier inside the tier. Default 1. */
  weight?: number;
  who?: StaffSelector;
  /**
   * Parts still showing example values (e.g. 'who', 'amount'). The rule is
   * ignored until every one has been set, so a placeholder never reaches a rota.
   */
  unset?: string[];
}

/** The selected people must not do the selected work on the selected days. */
export interface ForbidRule extends RuleBase {
  type: 'forbid';
  work: WorkSelector;
  days?: DaySelector;
}

/** The same person must cover a role on both linked shifts of a day (e.g. a full-day ward). */
export interface LinkShiftsRule extends RuleBase {
  type: 'linkShifts';
  roleId: Id;
  shiftTypeIds: [Id, Id];
  days?: DaySelector;
}

/**
 * A person must not do work A and work B on the same day. If A and B select the
 * same work, it means "at most one of these per day".
 */
export interface NotSameDayRule extends RuleBase {
  type: 'notSameDay';
  a: WorkSelector;
  b: WorkSelector;
  days?: DaySelector;
}

/** Min and/or max amount of selected work per person per period. */
export interface CountRule extends RuleBase {
  type: 'count';
  work: WorkSelector;
  days?: DaySelector;
  period: Period;
  unit: 'shifts' | 'hours';
  min?: number;
  max?: number;
  /** Multiply min/max by each person's FTE. */
  scaleByFte?: boolean;
  /** min/max are per week, averaged over the period (e.g. "average 48h a week"). */
  perWeekAverage?: boolean;
}

/** Reward pairing work A and work B for the same person on the same day. Always soft. */
export interface PairPreferenceRule extends RuleBase {
  type: 'pairPreference';
  a: WorkSelector;
  b: WorkSelector;
  days?: DaySelector;
}

/**
 * Nudge selected people towards ("more") or away from ("less") selected work.
 * Always soft, and by default in the 'preference' tier: it changes the mix of
 * work within a fair workload rather than adding work. For a specific number,
 * use a count rule with a minimum (a training target) instead.
 */
/**
 * Share some work evenly among these people, in proportion to the time each
 * was available (so anyone who missed time gets more later). Optimised in
 * the fairness tier, after training needs.
 */
export interface ShareRule extends RuleBase {
  type: 'share';
  work: WorkSelector;
  /** Some people get a bigger share: `times` as much per day available as everyone else. */
  favour?: Favour;
}

export interface Favour {
  who: StaffSelector;
  times: number;
}

/** Prefer putting these people on lists run by these consultants (pairing). */
export interface WorkWithRule extends RuleBase {
  type: 'workWith';
  work: WorkSelector;
  leadIds: Id[];
}

/** Keep each of these people with as few different consultants as possible (continuity). */
export interface FewLeadsRule extends RuleBase {
  type: 'fewLeads';
  work: WorkSelector;
}

export interface PreferenceRule extends RuleBase {
  type: 'preference';
  work: WorkSelector;
  days?: DaySelector;
  direction: 'more' | 'less';
}

/**
 * Minimum hours between the end of one shift and the start of the next.
 * Shifts separated by no more than `sameDutyGapHours` (default 1, e.g. an AM
 * session then a PM session) count as one continuous duty instead, as long as
 * that duty lasts no longer than `maxDutyHours` (default 13).
 */
export interface MinRestRule extends RuleBase {
  type: 'minRest';
  hours: number;
  sameDutyGapHours?: number;
  maxDutyHours?: number;
}

/** No more than maxDays consecutive days containing selected work. */
export interface MaxConsecutiveRule extends RuleBase {
  type: 'maxConsecutive';
  work: WorkSelector;
  maxDays: number;
}

/** After the last shift of a block of selected work (e.g. nights), rest for at least `hours`. */
export interface RestAfterBlockRule extends RuleBase {
  type: 'restAfterBlock';
  work: WorkSelector;
  hours: number;
}

/** No more than `hours` of work starting within any `windowDays` consecutive days. */
export interface MaxHoursRule extends RuleBase {
  type: 'maxHours';
  hours: number;
  windowDays: number;
  scaleByFte?: boolean;
}

/** Work on at most `maxWeekends` of any `inWeekends` consecutive weekends. */
export interface WeekendFrequencyRule extends RuleBase {
  type: 'weekendFrequency';
  maxWeekends: number;
  inWeekends: number;
}

/**
 * Skill mix: on each day, at least `min` of the selected people must be doing
 * the selected work (e.g. at least 1 O&G ST1-2 on nights, or on one post).
 * Only applies on days when that work is staffed.
 */
export interface SkillMixRule extends RuleBase {
  type: 'skillMix';
  work: WorkSelector;
  days?: DaySelector;
  min: number;
}

/** Selected work comes in blocks of at least `minDays` days (e.g. no single nights). */
export interface MinBlockRule extends RuleBase {
  type: 'minBlock';
  work: WorkSelector;
  minDays: number;
}

/** After `runDays` days in a row of the selected work, at least `hours` off (e.g. 48h after 4 long days). */
export interface RestAfterRunRule extends RuleBase {
  type: 'restAfterRun';
  work: WorkSelector;
  runDays: number;
  hours: number;
}

/** Try to keep the same doctor at a place on consecutive days, for up to `runDays` days. Always soft. */
export interface ContinuityRule extends RuleBase {
  type: 'continuity';
  roleId: Id;
  runDays: number;
}

export type Rule =
  | SkillMixRule
  | MinBlockRule
  | RestAfterRunRule
  | ContinuityRule
  | ForbidRule
  | LinkShiftsRule
  | NotSameDayRule
  | CountRule
  | PairPreferenceRule
  | PreferenceRule
  | ShareRule
  | WorkWithRule
  | FewLeadsRule
  | MinRestRule
  | MaxConsecutiveRule
  | RestAfterBlockRule
  | MaxHoursRule
  | WeekendFrequencyRule;

/** A dimension along which workload should be shared out in proportion to capacity. */
export interface FairnessDimension {
  id: Id;
  name: string;
  work?: WorkSelector;
  /** Only share among these people. Omitted means everyone. */
  who?: StaffSelector;
  /** These people's fair share is `times` as big. */
  favour?: Favour;
  /** Only count work touching these days, e.g. weekends. */
  weekendsOnly?: boolean;
  unit: 'shifts' | 'hours';
  weight?: number;
  /** Optional per-person capacity and relative share, used by specialised analyses. */
  capacityByStaff?: Record<Id, number>;
  factorsByStaff?: Record<Id, number>;
}

export interface Profile {
  name: string;
  shiftTypes: ShiftType[];
  roles: Role[];
  groups: Group[];
  staff: Staff[];
  demands: Demand[];
  rules: Rule[];
  fairness: FairnessDimension[];
  /** Consultants who run lists. */
  leads?: Lead[];
  tierOrder?: Tier[];
  /** Reward filling demand above its minimum (up to max) in the 'extra' tier. */
  useSpareCapacity?: boolean;
}

export interface RotaProblem {
  profile: Profile;
  start: ISODate;
  end: ISODate;
  unavailability: Unavailability[];
  fixed: FixedAssignment[];
}

export interface Assignment {
  staffId: Id;
  date: ISODate;
  shiftTypeId: Id;
  /** Undefined for an outside fixed commitment. */
  roleId?: Id;
  fixed?: boolean;
}
