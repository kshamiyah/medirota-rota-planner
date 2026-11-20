import { useEffect, useMemo, useRef, useState } from 'react';
import { shiftHours } from '../../engine/calendar';
import type { Rule } from '../../engine/types';
import { limitDefs } from '../rules/grid';
import { defaultSessionsSettings, gradeForStaff, type SessionsSettings } from '../sessions';
import { update, useWorkspace, newId } from '../store';
import { SessionTypesEditor } from '../components/SessionTypesEditor';
import { FetchBookmarkLink } from '../components/FetchBookmarkLink';
import { appUrl, isFetchBundle, makeFetchBookmark } from '../fetchBookmark';
import { applyImport, planImport, type ImportPlan } from '../mediImport';
import { isActivityWeek, isPersonWeek, parseActivityWeek, parsePersonWeek } from '../medirota';
import { readSetupReview, quickLookItems, saveSetupReview } from '../setupReview';
import { bookedShiftWarnings } from '../bookedShiftWarnings';
import { applyWizardDoctorChoice, applyWizardRoleChoice, type SetupWizardStep } from '../setupWizard';
import { formatDateLong } from '../components/ui';
import type { Page } from './types';

export const SETUP_PROGRESS_KEY = 'rota-planner.setup-progress.v1';
export function savedSetupStep(): SetupWizardStep {
  try { const value = localStorage.getItem(SETUP_PROGRESS_KEY); return value ? JSON.parse(value).step as SetupWizardStep : 'welcome'; } catch { return 'welcome'; }
}
export function saveSetupStep(step: SetupWizardStep): void { try { localStorage.setItem(SETUP_PROGRESS_KEY, JSON.stringify({ step })); } catch { /* the wizard can continue without a resume point */ } }
export function clearSetupStep(): void { try { localStorage.removeItem(SETUP_PROGRESS_KEY); } catch { /* optional resume point */ } }

export function suggestSessionType(name: string): string {
  const value = name.toLocaleLowerCase('en-GB');
  if (/\b(theatres?|surgery|sections?|lists?)\b/.test(value)) return 'Theatre';
  if (/\b(wards?|antenatal|postnatal)\b/.test(value)) return 'Wards';
  if (/\bnights?\b/.test(value)) return 'Nights';
  if (/\bclinics?\b/.test(value)) return 'Clinic';
  if (/\b(assessments?|triage|mau|eau|sau)\b/.test(value)) return 'Assessment';
  return 'Not counted';
}
export function suggestSessionKind(name: string, ws?: ReturnType<typeof useWorkspace>): 'day' | 'on-call' {
  const activities = Object.values(ws?.swapFinder?.snapshot.days ?? {}).flatMap(days => Object.values(days)).filter(day => day.activity === name);
  return activities.length ? (activities.filter(day => day.status === 'night' || day.status === 'longDay').length > activities.length / 2 ? 'on-call' : 'day') : 'day';
}

export function wizardSettingsDraft(ws: ReturnType<typeof useWorkspace>): SessionsSettings {
  if (ws.sessions) return structuredClone(ws.sessions);
  const grades = [...new Set(ws.profile.staff.map(person => gradeForStaff(person, ws.profile)).filter((grade): grade is string => !!grade))];
  const groups = grades.map((grade, index) => ({ id: `setup-grade-${index}`, name: grade, grades: [grade] }));
  return { ...defaultSessionsSettings(ws.profile), groups, ratios: {} };
}

export function commitWizardSessionsStep(workspace: { sessions?: SessionsSettings; profile: Parameters<typeof defaultSessionsSettings>[0] }, step: 'types' | 'groups' | 'shares' | 'ratios', draft: SessionsSettings): void {
  const baseline = structuredClone(workspace.sessions ?? defaultSessionsSettings(workspace.profile));
  const saved = structuredClone(baseline);
  if (step === 'types') saved.types = structuredClone(draft.types);
  if (step === 'groups') saved.groups = structuredClone(draft.groups);
  if (step === 'shares' || step === 'ratios') saved.ratios = structuredClone(draft.ratios);
  if (JSON.stringify(saved) !== JSON.stringify(baseline)) workspace.sessions = saved;
}

export interface NationalLimitRow { id: string; title: string; hint?: string; rule: Rule; values: number[]; parts: string[] }
export function nationalLimitRows(profile: Parameters<typeof defaultSessionsSettings>[0]): NationalLimitRow[] {
  const defs = limitDefs(profile);
  const definition = (id: string) => defs.find(item => item.id === id);
  const makeRule = (definitionId: string, id: string, values: number[]): Rule => {
    const found = definition(definitionId);
    if (!found) throw new Error(`Missing working-time limit definition: ${definitionId}`);
    return { ...found.make(values), id, name: '' };
  };
  const shiftIds = (id: string) => {
    const rule = definition(id)?.make([4]);
    return rule && 'work' in rule ? [...(rule.work.shiftTypeIds ?? [])].sort() : [];
  };
  const nights = shiftIds('nights');
  // Para 10: national long-day rules use shifts longer than 10 hours (Settings → Rules still matches ≥ 10 via limitDefs).
  const longDays = profile.shiftTypes.filter(shift => shift.end > shift.start && shiftHours(shift) > 10).map(shift => shift.id).sort();
  const withLongDayShifts = (rule: Rule): Rule => ('work' in rule ? { ...rule, work: { ...rule.work, shiftTypeIds: longDays } } : rule);
  const rows: NationalLimitRow[] = [
    { id: 'national-rest', title: 'Rest between shifts', rule: makeRule('rest', 'national-rest', [11]), values: [11], parts: ['At least', 'hours off between shifts'] },
    { id: 'national-hours-7', title: 'Hours in any 7 days', rule: makeRule('hours7', 'national-hours-7', [72, 7]), values: [72], parts: ['At most', 'hours in any 7 days'] },
    { id: 'national-hours-average', title: 'Average weekly hours', hint: 'Averaged over your imported weeks; the contract uses 26 weeks.', rule: makeRule('avg', 'national-hours-average', [48]), values: [48], parts: ['At most', 'hours a week on average (less for part-timers)'] },
    { id: 'national-days', title: 'Days in a row', rule: makeRule('days', 'national-days', [7]), values: [7], parts: ['At most', 'days in a row'] },
    { id: 'national-days-rest', title: 'Rest after 7 days in a row', rule: makeRule('postdays', 'national-days-rest', [7, 48]), values: [48], parts: ['Then at least', 'hours off'] },
    { id: 'national-weekend-hard', title: 'Weekends', rule: makeRule('weekends', 'national-weekend-hard', [1, 2]), values: [1, 2], parts: ['No more than', 'in every', 'weekends'] },
    { id: 'national-weekend-aim', title: 'Weekend aim', rule: makeRule('weekendAim', 'national-weekend-aim', [1, 3]), values: [1, 3], parts: ['Aim for no more than', 'in every', 'weekends'] },
  ];
  if (nights.length) rows.push(
    { id: 'national-nights', title: 'Nights in a row', rule: makeRule('nights', 'national-nights', [4]), values: [4], parts: ['At most', 'nights in a row'] },
    { id: 'national-after-nights', title: 'Rest after nights', rule: makeRule('postnights', 'national-after-nights', [46]), values: [46], parts: ['At least', 'hours off after nights'] },
  );
  if (longDays.length) rows.push(
    { id: 'national-long-days', title: 'Long days in a row', rule: withLongDayShifts(makeRule('longdays', 'national-long-days', [4])), values: [4], parts: ['At most', 'long days in a row'] },
    { id: 'national-long-rest', title: 'Rest after 4 long days', rule: withLongDayShifts(makeRule('postlongdays', 'national-long-rest', [4, 48])), values: [48], parts: ['Then at least', 'hours off'] },
  );
  return rows;
}

/** National-managed: everyone, no place/group filters, same type/hard/shift set as the national row. */
function sameRuleShape(a: Rule, b: Rule): boolean {
  if (a.type !== b.type || a.hard !== b.hard) return false;
  if (a.who?.groupIds?.length || a.who?.staffIds?.length || b.who?.groupIds?.length || b.who?.staffIds?.length) return false;
  if (a.type === 'weekendFrequency' && b.type === 'weekendFrequency') return a.maxWeekends === b.maxWeekends && a.inWeekends === b.inWeekends;
  const workBits = (rule: Rule) => {
    if (!('work' in rule)) return { shifts: '', places: false };
    return {
      shifts: [...(rule.work.shiftTypeIds ?? [])].sort().join('|'),
      places: !!(rule.work.roleIds?.length || rule.work.categories?.length),
    };
  };
  const left = workBits(a), right = workBits(b);
  if (left.places || right.places) return false;
  return left.shifts === right.shifts;
}
function activeNationalRule(rules: Rule[], row: NationalLimitRow): Rule | undefined {
  return rules.find(rule => rule.id === row.id) ?? rules.find(rule => sameRuleShape(rule, row.rule));
}
function ruleNumbers(rule: Rule, defaults: number[]): number[] {
  switch (rule.type) {
    case 'minRest': return [rule.hours];
    case 'maxHours': return [rule.hours];
    case 'count': return [rule.max ?? defaults[0]];
    case 'maxConsecutive': return [rule.maxDays];
    case 'restAfterRun': return [rule.hours];
    case 'restAfterBlock': return [rule.hours];
    case 'weekendFrequency': return [rule.maxWeekends, rule.inWeekends];
    default: return defaults;
  }
}
export function applyNationalLimitRows(profile: Parameters<typeof defaultSessionsSettings>[0], previous: Rule[]): Rule[] {
  const rows = nationalLimitRows(profile);
  const relevant = new Set<string>();
  for (const row of rows) { const existing = activeNationalRule(previous, row); if (existing) relevant.add(existing.id); }
  return [...previous.filter(rule => !relevant.has(rule.id)), ...rows.map(row => structuredClone(row.rule))];
}

const weekdayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export function suggestedMinimums(ws: ReturnType<typeof useWorkspace>): number[] {
  return weekdayNames.map((_, day) => ws.profile.demands.filter(demand => {
    const shift = ws.profile.shiftTypes.find(item => item.id === demand.shiftTypeId);
    // One-off date staffing needs are not weekday suggestions.
    if (demand.days.dates?.length) return false;
    return !!shift && shift.end > shift.start && (!demand.days.weekdays?.length || demand.days.weekdays.includes(day as 0|1|2|3|4|5|6));
  }).reduce((sum, demand) => sum + demand.min, 0));
}

/** Plain English for a share value of N against a baseline of 1. */
export function shareSentence(groupName: string, baselineName: string, typeName: string, value: number): string {
  const type = typeName.toLowerCase();
  if (value === 1) return `${groupName}s are expected to do the same number of ${type} sessions as ${baselineName}s.`;
  if (value === 2) return `${groupName}s are expected to do twice as many ${type} sessions as ${baselineName}s.`;
  if (value === 0) return `${groupName}s are not expected to do ${type} sessions.`;
  return `${groupName}s are expected to do ${value} times as many ${type} sessions as ${baselineName}s.`;
}

export function sharesAreEqual(settings: SessionsSettings): boolean {
  return settings.types.every(type => settings.groups.every(group => (settings.ratios[type.id]?.[group.id] ?? 1) === 1));
}
function importedSummary(ws: ReturnType<typeof useWorkspace>): string {
  const weeks = Object.keys(ws.swapFinder?.snapshot.importedAt ?? {}).sort();
  if (!weeks.length) return 'No rota imported yet';
  const end = new Date(`${weeks.at(-1)}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6);
  return `${weeks.length} ${weeks.length === 1 ? 'week' : 'weeks'} (${formatDateLong(weeks[0]!)} – ${formatDateLong(end.toISOString().slice(0, 10))}) · ${ws.profile.staff.length} doctors · ${ws.profile.roles.filter(role => !role.parentId).length} places`;
}
function newFirstTimeDraft(mode: 'firstRun' | 'rerun', ws: ReturnType<typeof useWorkspace>): boolean { return mode === 'firstRun' && !ws.sessions?.types.length && Object.keys(ws.swapFinder?.snapshot.importedAt ?? {}).length > 0; }

export function SetupWizard({ mode, initialStep = 'welcome', onFinish, onLeave, onReviewDetails, onNavigate }: {
  mode: 'firstRun' | 'rerun'; initialStep?: SetupWizardStep; onFinish: () => void; onLeave: () => void; onReviewDetails: () => void; onNavigate: (page: Page) => void;
}) {
  const ws = useWorkspace();
  const [step, setStep] = useState<SetupWizardStep>(initialStep);
  const [roleDraft, setRoleDraft] = useState<'doctor' | 'coordinator' | undefined>(mode === 'firstRun' ? ws.role : ws.role ?? 'doctor');
  const [doctorDraft, setDoctorDraft] = useState(ws.me ?? '');
  const [query, setQuery] = useState('');
  const [settingsDraft, setSettingsDraft] = useState<SessionsSettings>(() => wizardSettingsDraft(ws));
  const [typesReady, setTypesReady] = useState(false);
  const [unselectedKindIds, setUnselectedKindIds] = useState<Set<string>>(() => new Set());
  const [typeDirty, setTypeDirty] = useState(false);
  const [groupDirty, setGroupDirty] = useState(false);
  const [shareDirty, setShareDirty] = useState(false);
  const [renamed, setRenamed] = useState<Record<string, string>>({});
  const [minimumDraft, setMinimumDraft] = useState(() => ({ weekdays: [...(ws.swapFinder?.settings.minDoctors ?? [0,0,0,0,0,0,0])], bankHoliday: ws.swapFinder?.settings.minDoctorsBankHoliday ?? 0 }));
  const [minimumDirty, setMinimumDirty] = useState(false);
  const [ruleDraft, setRuleDraft] = useState<Rule[]>(() => structuredClone(ws.profile.rules));
  const [ruleDirty, setRuleDirty] = useState(false);
  const [shareChoice, setShareChoice] = useState<'yes' | 'no'>(() => mode === 'rerun' && ws.sessions && !sharesAreEqual(ws.sessions) ? 'no' : 'yes');
  const [shareTypeIndex, setShareTypeIndex] = useState(-1);
  const [quickFix, setQuickFix] = useState<'grade' | 'activity' | 'locum' | null>(null);
  const [reviewPlan, setReviewPlan] = useState<ImportPlan | undefined>(() => readSetupReview());
  const setupFileRef = useRef<HTMLInputElement>(null);
  const bookmark = useMemo(() => makeFetchBookmark(appUrl()), []);
  const importedAt = ws.swapFinder?.snapshot.importedAt ?? {};
  const hasRota = Object.keys(importedAt).length > 0;
  const medirotaOrigin = ws.medirotaFetch?.origin;
  const coordinator = roleDraft === 'coordinator';
  const steps: SetupWizardStep[] = ['welcome', 'role', 'bookmark', 'fetch', ...(hasRota ? ['summary' as const, ...(!coordinator ? ['doctor' as const] : []), 'types' as const, 'groups' as const, 'shares' as const, 'minimums' as const] : []), 'rules'];
  const stepNumber = step === 'finish' ? steps.length + 1 : steps.indexOf(step) + 1;
  const stepTitle: Record<SetupWizardStep, string> = {
    welcome: 'Welcome', role: 'Who are you?', bookmark: 'Add the bookmark', fetch: 'Fetch your rota', summary: 'Got your rota ✓', doctor: 'Which doctor are you?',
    types: 'Sort places into session types', groups: 'Comparison groups', shares: 'Shares', minimums: 'Minimum doctors', rules: 'Working-time rules', finish: "You're set up",
  };
  const activeStep = step === 'finish' ? steps.length + 1 : stepNumber;
  const profile = ws.profile;
  const places = profile.roles.filter(role => !role.parentId).map(role => ({ id: role.id, name: renamed[role.id] ?? role.displayName ?? role.name, originalName: role.displayName ? role.name : undefined }));
  const noGradePeople = profile.staff.filter(person => !gradeForStaff(person, profile));
  const gradeNames = [...new Set(profile.staff.map(person => gradeForStaff(person, profile)).filter((grade): grade is string => !!grade))];
  const unplaced = gradeNames.filter(grade => !settingsDraft.groups.some(group => group.grades.some(item => item.toLowerCase() === grade.toLowerCase())));
  const dayTypes = settingsDraft.types.filter(type => type.kind === 'day');
  const shareIndex = shareTypeIndex < 0 ? 0 : shareTypeIndex;
  const currentShareType = dayTypes[shareIndex];
  const firstTimeDraft = newFirstTimeDraft(mode, ws);
  const unsortedPlaceIds = firstTimeDraft ? places.map(place => place.id) : [];
  const minSuggestions = suggestedMinimums(ws);
  const changed = (key: 'type' | 'group' | 'share') => key === 'type' ? setTypeDirty(true) : key === 'group' ? setGroupDirty(true) : setShareDirty(true);

  useEffect(() => { saveSetupStep(step); }, [step]);
  useEffect(() => { if (step === 'fetch' && hasRota) { setReviewPlan(readSetupReview()); setStep('summary'); } }, [step, hasRota]);
  useEffect(() => { if (hasRota && mode === 'firstRun' && !ws.sessions) setSettingsDraft(wizardSettingsDraft(ws)); }, [hasRota]);
  useEffect(() => { if (mode === 'rerun') return; document.title = hasRota ? '✓ Rota Planner' : 'Rota Planner'; return () => { document.title = 'Rota Planner'; }; }, [hasRota, mode]);

  const persistTypeAndNames = () => update(workspace => {
    if (typeDirty) commitWizardSessionsStep(workspace, 'types', settingsDraft);
    for (const [id, name] of Object.entries(renamed)) {
      const place = workspace.profile.roles.find(role => role.id === id);
      if (place && name.trim() && name.trim() !== (place.displayName ?? place.name)) place.displayName = name.trim();
    }
  });
  const persistGroups = () => update(workspace => { if (groupDirty) commitWizardSessionsStep(workspace, 'groups', settingsDraft); });
  const persistShares = () => update(workspace => {
    if (!shareDirty && mode !== 'firstRun') return;
    const saved = structuredClone(settingsDraft);
    if (shareChoice === 'yes') for (const type of saved.types) saved.ratios[type.id] = Object.fromEntries(saved.groups.map(group => [group.id, 1]));
    else {
      for (const type of saved.types.filter(item => item.kind === 'on-call')) saved.ratios[type.id] = Object.fromEntries(saved.groups.map(group => [group.id, 1]));
      for (const type of saved.types.filter(item => item.kind === 'day')) {
        const baseline = saved.groups[0];
        const ratios = { ...(saved.ratios[type.id] ?? {}) };
        if (baseline) ratios[baseline.id] = 1;
        for (const group of saved.groups.slice(1)) ratios[group.id] = ratios[group.id] ?? 1;
        saved.ratios[type.id] = ratios;
      }
    }
    if (mode === 'firstRun') workspace.sessions = saved;
    else if (workspace.sessions) workspace.sessions.ratios = saved.ratios;
    else workspace.sessions = saved;
  });
  const setShareForGroup = (typeId: string, groupId: string, value: number) => {
    setSettingsDraft(current => {
      const baseline = current.groups[0];
      const ratios = { ...(current.ratios[typeId] ?? {}) };
      if (baseline) ratios[baseline.id] = 1;
      ratios[groupId] = value;
      return { ...current, ratios: { ...current.ratios, [typeId]: ratios } };
    });
    changed('share');
  };
  const nextStep = (current = step): SetupWizardStep => {
    if (current === 'welcome') return 'role';
    if (current === 'role') return 'bookmark';
    if (current === 'bookmark') return 'fetch';
    if (current === 'fetch') return hasRota ? 'summary' : 'rules';
    if (current === 'summary') return coordinator ? 'types' : 'doctor';
    if (current === 'doctor') return 'types';
    if (current === 'types') return 'groups';
    if (current === 'groups') return 'shares';
    if (current === 'shares') return 'minimums';
    if (current === 'minimums') return 'rules';
    if (current === 'rules') return 'finish';
    return 'finish';
  };
  const move = (action: 'next' | 'back' | 'skip') => {
    if (action === 'back') { const i = steps.indexOf(step); setStep(steps[Math.max(0, i - 1)] ?? 'welcome'); return; }
    if (action === 'skip') {
      if (step === 'welcome') { onLeave(); return; }
      if (step === 'fetch') { setStep('rules'); return; }
      if (step === 'types') { setSettingsDraft(wizardSettingsDraft(ws)); setRenamed({}); setUnselectedKindIds(new Set()); }
      if (step === 'rules') { setStep('finish'); return; }
      setStep(nextStep()); return;
    }
    if (step === 'role' && roleDraft) update(workspace => applyWizardRoleChoice(workspace, roleDraft, mode));
    if (step === 'doctor' && doctorDraft) update(workspace => applyWizardDoctorChoice(workspace, doctorDraft, mode));
    if (step === 'types') persistTypeAndNames();
    if (step === 'groups') persistGroups();
    if (step === 'shares') persistShares();
    if (step === 'minimums' && minimumDirty && ws.swapFinder) update(workspace => { if (!workspace.swapFinder) return; workspace.swapFinder.settings.minDoctors = [...minimumDraft.weekdays]; workspace.swapFinder.settings.minDoctorsBankHoliday = minimumDraft.bankHoliday; });
    if (step === 'rules' && ruleDirty) update(workspace => { workspace.profile.rules = structuredClone(ruleDraft); });
    if (step === 'shares' && shareChoice === 'no') {
      if (shareTypeIndex < 0) {
        setSettingsDraft(current => {
          const next = structuredClone(current);
          for (const type of next.types.filter(item => item.kind === 'day')) {
            next.ratios[type.id] = Object.fromEntries(next.groups.map(group => [group.id, next.ratios[type.id]?.[group.id] ?? 1]));
          }
          return next;
        });
        setShareTypeIndex(0);
        return;
      }
      if (shareTypeIndex + 1 < dayTypes.length) { setShareTypeIndex(shareTypeIndex + 1); return; }
    }
    setStep(nextStep());
  };
  const backFromShare = () => { if (step === 'shares' && shareChoice === 'no' && shareTypeIndex > 0) setShareTypeIndex(shareTypeIndex - 1); else if (step === 'shares' && shareChoice === 'no' && shareTypeIndex === 0) setShareTypeIndex(-1); else move('back'); };
  const changeGroup = (grade: string, targetId: string) => {
    setSettingsDraft(current => {
      const next = structuredClone(current);
      next.groups = next.groups.map(group => ({ ...group, grades: group.grades.filter(item => item !== grade) }));
      if (targetId === '__new') next.groups.push({ id: newId('compare'), name: grade, grades: [grade] });
      else next.groups.find(group => group.id === targetId)?.grades.push(grade);
      next.groups = next.groups.filter(group => group.grades.length || group.staffIds?.length);
      return next;
    }); changed('group');
  };
  const addComparisonGroup = () => { setSettingsDraft(current => ({ ...current, groups: [...current.groups, { id: newId('compare'), name: 'New comparison group', grades: [] }] })); changed('group'); };
  const moveUngraded = (staffId: string, groupId: string) => {
    setSettingsDraft(current => ({ ...current, groups: current.groups.map(group => ({ ...group, staffIds: group.id === groupId ? [...new Set([...(group.staffIds ?? []), staffId])] : (group.staffIds ?? []).filter(id => id !== staffId) })) })); changed('group');
  };
  const selectedGrade = doctorDraft ? gradeForStaff(profile.staff.find(person => person.id === doctorDraft)!, profile) : undefined;
  const viewerGroupId = selectedGrade ? settingsDraft.groups.find(group => group.grades.includes(selectedGrade))?.id : settingsDraft.groups.find(group => group.staffIds?.includes(doctorDraft))?.id;
  const quick = reviewPlan ? quickLookItems(reviewPlan) : { noGrade: noGradePeople.length, unsortedActivities: [], extraOnly: [] };
  const updateReviewPlan = (next: typeof reviewPlan) => { if (!next) return; saveSetupReview(next); setReviewPlan(next); update(workspace => { applyImport(workspace, next); }); };
  const setReviewActivity = (name: string, treat: 'night'|'long'|'dayjob'|'leave'|'training'|'zero'|'unavailable'|'ignore', placeId?: string) => {
    if (!reviewPlan) return;
    updateReviewPlan({ ...reviewPlan, activities: reviewPlan.activities.map(activity => activity.name === name ? { ...activity, treat, ...(treat === 'night' || treat === 'long' || treat === 'dayjob' ? { placeId: placeId ?? 'new' } : { placeId: undefined }) } : activity) });
  };
  const setReviewPersonGrade = (mediRotaId: string, grade: string) => {
    if (!reviewPlan) return;
    updateReviewPlan({ ...reviewPlan, people: reviewPlan.people.map(person => person.mediRotaId === mediRotaId ? { ...person, grade } : person) });
  };
  const setReviewPersonLocum = (mediRotaId: string, locum: boolean) => {
    if (!reviewPlan) return;
    updateReviewPlan({ ...reviewPlan, people: reviewPlan.people.map(person => person.mediRotaId === mediRotaId ? { ...person, locum } : person) });
  };
  const changeLimitValue = (row: NationalLimitRow, index: number, value: number) => {
    setRuleDraft(current => {
      const active = activeNationalRule(current, row);
      if (!active) return current;
      const next = structuredClone(active);
      switch (next.type) {
        case 'minRest': next.hours = value; break;
        case 'maxHours': next.hours = value; break;
        case 'count': next.max = value; break;
        case 'maxConsecutive': next.maxDays = value; break;
        case 'restAfterRun': next.hours = value; break;
        case 'restAfterBlock': next.hours = value; break;
        case 'weekendFrequency': if (index === 0) next.maxWeekends = value; else next.inWeekends = value; break;
      }
      return current.map(rule => rule.id === active.id ? next : rule);
    });
    setRuleDirty(true);
  };

  if (step === 'finish') {
    const ruleState = ws.profile.rules.length ? ws.profile.rules.some(rule => rule.id.startsWith('national-')) ? 'National limits (2016 contract)' : 'Your own limits' : 'None set yet';
    return <div className="setup-wizard-page"><section className="setup-wizard-card"><p className="eyebrow">Step {activeStep} of {activeStep}</p><h1>You're set up</h1><dl><dt>You</dt><dd>{coordinator ? 'Coordinator' : `${profile.staff.find(person => person.id === ws.me)?.name ?? 'Doctor'}${selectedGrade ? ` · ${selectedGrade}` : ''}`}</dd>{hasRota && <><dt>Your rota</dt><dd>{importedSummary(ws)}</dd></>}<dt>Session types</dt><dd>{ws.sessions?.types.length ?? settingsDraft.types.length}</dd><dt>Comparison groups</dt><dd>{ws.sessions?.groups.length ?? settingsDraft.groups.length}</dd><dt>Working-time rules</dt><dd>{ruleState}</dd></dl><h2>What would you like to do first?</h2><div className="row">{coordinator ? <><button onClick={() => onFinishGo('overview')}>Look at the rota</button><button onClick={() => onFinishGo('fairer')}>Fairer rota</button><button onClick={() => onFinishGo('sessions')}>Sessions</button></> : <><button onClick={() => onFinishGo('swaps')}>Find a swap</button><button onClick={() => onFinishGo('sessions')}>See my sessions</button><button onClick={() => onFinishGo('overview')}>Look at the rota</button></>}</div><p className="small muted">You can change any of this in Settings.</p>{!hasRota && <p>Next: get your rota from MediRota <FetchBookmarkLink href={bookmark}>Fetch from MediRota</FetchBookmarkLink></p>}<footer className="setup-wizard-actions"><button type="button" onClick={() => setStep('rules')}>Back</button><button className="primary" type="button" onClick={onFinish}>Finish setup</button></footer></section></div>;
  }

  function onFinishGo(page: Page) { onFinish(); onNavigate(page); }

  const importSetupFiles = async (list: FileList | File[]) => {
    const person = new Map<string, ReturnType<typeof parsePersonWeek>>();
    const activity = new Map<string, ReturnType<typeof parseActivityWeek>>();
    for (const file of Array.from(list)) {
      try {
        const html = await file.text();
        let json: unknown; try { json = JSON.parse(html); } catch { json = null; }
        if (isFetchBundle(json)) {
          for (const week of json.weeks) {
            if (week.html && isPersonWeek(week.html)) person.set(week.start, parsePersonWeek(week.html));
            if (week.activityHtml && isActivityWeek(week.activityHtml)) activity.set(week.start, parseActivityWeek(week.activityHtml));
          }
        } else if (isPersonWeek(html)) { const week = parsePersonWeek(html); person.set(week.start, week); }
        else if (isActivityWeek(html)) { const week = parseActivityWeek(html); activity.set(week.start, week); }
      } catch { /* skip unreadable files; the person can try again */ }
    }
    const personWeeks = [...person.values()].sort((a, b) => a.start.localeCompare(b.start));
    const activityWeeks = [...activity.values()].sort((a, b) => a.start.localeCompare(b.start));
    if (!personWeeks.length) return;
    const importPlan = planImport(ws, personWeeks, activityWeeks, { firstTimeSummary: true });
    saveSetupReview(importPlan);
    setReviewPlan(importPlan);
    update(workspace => { applyImport(workspace, importPlan); });
  };

  const headingOnly = <><div className="setup-wizard-progress"><span>Step {stepNumber} of {steps.length + 1}</span></div><h1 id="setup-wizard-title">{stepTitle[step]}</h1></>;
  const detailsButton = (title: string, count: number, onClick: () => void) => count > 0 && <button type="button" className="link-button" aria-label={`Fix ${title.toLowerCase()} (${count})`} onClick={onClick}>[Fix]</button>;
  const makeOwnGroup = (staffId: string) => {
    const person = profile.staff.find(item => item.id === staffId);
    const group = { id: newId('compare'), name: person?.name ?? 'Doctor', grades: [] as string[], staffIds: [staffId] };
    setSettingsDraft(current => ({ ...current, groups: [group, ...current.groups] })); changed('group');
  };

  return <div className="setup-wizard-page"><section className="setup-wizard-card" aria-labelledby="setup-wizard-title">
    <header className="row" style={{ justifyContent: 'space-between' }}><b>Rota Planner</b>{step !== 'welcome' && <button className="link-button small" type="button" onClick={onLeave}>Leave setup</button>}</header>
    {headingOnly}
    {step === 'welcome' && <div className="setup-wizard-step"><p>See your rota, find swaps and check fairness, using your MediRota rota.</p><p>Your rota stays in this browser. Nothing is sent anywhere.</p><button className="primary" type="button" onClick={() => move('next')}>Get started</button><button type="button" className="link-button small" onClick={onLeave}>Look around first</button></div>}
    {step === 'role' && <fieldset className="setup-wizard-step"><legend className="visually-hidden">Who are you?</legend><label className="setup-doctor-option"><input type="radio" name="setup-role" checked={roleDraft === 'doctor'} onChange={() => setRoleDraft('doctor')} /> A doctor on this rota</label><label className="setup-doctor-option"><input type="radio" name="setup-role" checked={roleDraft === 'coordinator'} onChange={() => setRoleDraft('coordinator')} /> I make the rota (coordinator)</label></fieldset>}
    {step === 'bookmark' && <div className="setup-wizard-step"><p>Drag this button to your bookmarks bar. Then you can fetch weeks from MediRota.</p><svg className="setup-bookmark-illustration" viewBox="0 0 520 110" role="img" aria-label="Drag the bookmark button up to the bookmarks bar"><rect x="8" y="8" width="504" height="30" rx="8" fill="var(--panel-2)" stroke="var(--line)"/><text x="20" y="28" fill="var(--muted)" fontSize="13">Bookmarks bar</text><path d="M250 86 C250 60 260 55 260 42" fill="none" stroke="var(--accent)" strokeWidth="3" strokeDasharray="5 5"/><path d="M253 47 L260 39 L267 47" fill="none" stroke="var(--accent)" strokeWidth="3"/><rect x="180" y="69" width="160" height="30" rx="8" fill="var(--accent)"/><text x="194" y="89" fill="white" fontSize="14">Fetch from MediRota</text></svg><FetchBookmarkLink className="primary" href={bookmark}>⠿ Fetch from MediRota</FetchBookmarkLink><p className="small muted">Can't see your bookmarks bar? Press ⌘ Shift B (Ctrl Shift B on Windows).</p><details><summary>Can't drag it? Copy it instead</summary><button type="button" onClick={() => void navigator.clipboard?.writeText(bookmark)}>Copy bookmark code</button><ol><li>Create a new bookmark in your browser.</li><li>Name it Fetch from MediRota.</li><li>Paste the copied code into its address field and save.</li></ol></details><p>When you've added it, continue to fetch your rota.</p></div>}
    {step === 'fetch' && <div className="setup-wizard-step"><ol><li>Open MediRota in another tab and sign in.</li><li>Go to Rota → By person, the page listing everyone's shifts for a week.</li><li>Click the Fetch from MediRota bookmark.</li></ol><p role="status">{hasRota ? 'Your rota has arrived.' : 'Waiting for your rota…'}</p>{!hasRota && <details><summary>Other ways to get your rota in</summary><p className="small muted">For computers that block bookmarks, drop saved MediRota pages or a fetch bundle here.</p><input ref={setupFileRef} type="file" accept=".html,.htm,.json,text/html,application/json" multiple hidden onChange={event => { if (event.target.files) void importSetupFiles(event.target.files); event.target.value = ''; }} /><label className="drop" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void importSetupFiles(event.dataTransfer.files); }}><b>Drop saved MediRota pages or a fetch bundle (.json) here</b><span className="muted small">or click to choose them.</span><button type="button" onClick={() => setupFileRef.current?.click()}>Choose files</button></label></details>}</div>}
    {step === 'summary' && <div className="setup-wizard-step"><p>{importedSummary(ws)}</p><h2>Needs a quick look{quick.noGrade + quick.unsortedActivities.length + quick.extraOnly.length ? ` (${quick.noGrade + quick.unsortedActivities.length + quick.extraOnly.length})` : ''}</h2>{quick.noGrade === 0 && quick.unsortedActivities.length === 0 && quick.extraOnly.length === 0 && <p>Everything has a grade and a recognised activity.</p>}{quick.noGrade > 0 && <p>⚠ {quick.noGrade} {quick.noGrade === 1 ? 'doctor has' : 'doctors have'} no grade in MediRota {detailsButton('Fix grades', quick.noGrade, () => setQuickFix('grade'))}</p>}{quick.unsortedActivities.length > 0 && <p>⚠ {quick.unsortedActivities.length} {quick.unsortedActivities.length === 1 ? 'activity we couldn’t sort' : 'activities we couldn’t sort'} {detailsButton('Sort activities', quick.unsortedActivities.length, () => setQuickFix('activity'))}</p>}{quick.extraOnly.length > 0 && <p>⚠ {quick.extraOnly.length} {quick.extraOnly.length === 1 ? 'doctor only worked' : 'doctors only worked'} extra shifts: are they locums? {detailsButton('Check locums', quick.extraOnly.length, () => setQuickFix('locum'))}</p>}<button className="primary" type="button" onClick={() => move('next')}>Looks right, carry on</button><button className="link-button" type="button" onClick={onReviewDetails}>Check the details ▸</button>
      {quickFix === 'grade' && reviewPlan && <section className="card"><h3>Doctors without a grade</h3>{reviewPlan.people.filter(person => person.action !== 'skip' && !person.grade).map(person => <label className="field" key={person.mediRotaId}>{person.name}<select value="" onChange={event => setReviewPersonGrade(person.mediRotaId, event.target.value)}><option value="" disabled>Choose a grade</option>{[...new Set([...profile.groups.map(group => group.name), ...gradeNames, ...reviewPlan.people.map(item => item.grade).filter((grade): grade is string => !!grade)])].map(grade => <option key={grade}>{grade}</option>)}</select></label>)}<button onClick={() => setQuickFix(null)}>Done</button></section>}
      {quickFix === 'activity' && reviewPlan && <section className="card"><h3>Activities to sort</h3>{quick.unsortedActivities.map(name => <label className="field" key={name}>{name}<select value="ignore" onChange={event => setReviewActivity(name, event.target.value as 'night'|'long'|'dayjob'|'leave'|'training'|'zero'|'unavailable')}><option value="ignore">Not counted</option><option value="night">Booked night</option><option value="long">Booked long day</option><option value="dayjob">Day job</option><option value="leave">Leave</option><option value="training">Training</option><option value="zero">Zero day</option><option value="unavailable">Not available</option></select></label>)}<button onClick={() => setQuickFix(null)}>Done</button></section>}
      {quickFix === 'locum' && reviewPlan && <section className="card"><h3>Doctors who only worked extra shifts</h3>{quick.extraOnly.map(id => { const person = reviewPlan.people.find(item => item.mediRotaId === id); return person && <label key={id}><input type="checkbox" checked={!!person.locum} onChange={event => setReviewPersonLocum(id, event.target.checked)} />{person.name} is a locum</label>; })}<button onClick={() => setQuickFix(null)}>Done</button></section>}
    </div>}
    {step === 'doctor' && <div className="setup-wizard-step"><label className="field">Find a doctor<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Type a name or grade" /></label><div className="setup-card-grid">{profile.staff.filter(person => !person.locum || person.regularLocum).filter(person => !query || `${person.name} ${gradeForStaff(person, profile) ?? ''}`.toLowerCase().includes(query.toLowerCase())).map(person => <label key={person.id} className="setup-choice-card" aria-pressed={doctorDraft === person.id}><input type="radio" name="setup-doctor" checked={doctorDraft === person.id} onChange={() => setDoctorDraft(person.id)} />{person.name} <small>{gradeForStaff(person, profile) ?? 'No grade'}</small></label>)}</div></div>}
    {step === 'types' && <div className="setup-wizard-step"><SessionTypesEditor settings={settingsDraft} places={places} unsortedPlaceIds={unsortedPlaceIds} bookedWarnings={bookedShiftWarnings(profile, ws.swapFinder?.snapshot)} initialUnselectedKindIds={[...unselectedKindIds]} kindRequired={firstTimeDraft} onUnselectedKindChange={(id, unselected) => setUnselectedKindIds(current => { const next = new Set(current); if (unselected) next.add(id); else next.delete(id); return next; })} onKindsReadyChange={setTypesReady} onRenamePlace={(id, name) => { setRenamed(current => ({ ...current, [id]: name })); setTypeDirty(true); }} onChange={next => { setSettingsDraft(next); setTypeDirty(true); }} /></div>}
    {step === 'groups' && <div className="setup-wizard-step"><p>Sessions compares your work with doctors in your comparison group. Put grades that do the same job together, such as ST1 and ST2.</p>{!coordinator && viewerGroupId && <p className="notice">You're compared with these doctors.</p>}<div className="setup-card-grid">{[...settingsDraft.groups].sort((a, b) => Number(b.id === viewerGroupId) - Number(a.id === viewerGroupId)).map((group, index) => <article key={group.id} className={`setup-choice-card ${group.id === viewerGroupId ? 'setup-own-group' : ''}`}><label className="field">Comparison group name<input value={group.name} onChange={event => { setSettingsDraft(current => ({ ...current, groups: current.groups.map(item => item.id === group.id ? { ...item, name: event.target.value } : item) })); changed('group'); }} /></label>{group.grades.map(grade => <label key={grade} className="setup-group-chip">{grade}<select aria-label={`Move ${grade} to…`} value={group.id} onChange={event => changeGroup(grade, event.target.value)}>{settingsDraft.groups.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}<option value="__new">New group</option></select></label>)}{group.staffIds?.map(id => { const person = profile.staff.find(item => item.id === id); return person && <p key={id}>{person.name}</p>; })}<span className="small muted">{group.id === viewerGroupId ? "You're compared with these" : `Group ${index + 1}`}</span></article>)}</div>{unplaced.map(grade => <label key={grade} className="field">{grade}<select aria-label={`Move ${grade} to…`} value="" onChange={event => changeGroup(grade, event.target.value)}><option value="" disabled>Choose comparison group</option>{settingsDraft.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}<option value="__new">New group</option></select></label>)}{noGradePeople.length > 0 && <><h2>No grade in MediRota</h2>{noGradePeople.map(person => <label className="field" key={person.id}>{person.name}<select value={settingsDraft.groups.find(group => group.staffIds?.includes(person.id))?.id ?? ''} onChange={event => event.target.value === '__new' ? makeOwnGroup(person.id) : moveUngraded(person.id, event.target.value)}><option value="">Choose comparison group</option>{settingsDraft.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}<option value="__new">New group</option></select></label>)}</>}<button type="button" onClick={addComparisonGroup}>+ New group</button></div>}
    {step === 'shares' && <div className="setup-wizard-step">{shareTypeIndex < 0 ? <><p>Should every grade do the same share of each session type?</p><label><input type="radio" checked={shareChoice === 'yes'} onChange={() => { setShareChoice('yes'); setShareDirty(true); }} /> Yes, the same for everyone (most departments)</label><label><input type="radio" checked={shareChoice === 'no'} onChange={() => { setShareChoice('no'); setShareDirty(true); }} /> No, some grades do more of some types</label></> : currentShareType ? <><h2>{currentShareType.name}</h2>{settingsDraft.groups.length < 2 ? <p>Add another comparison group before setting different shares.</p> : settingsDraft.groups.slice(1).map(group => { const baseline = settingsDraft.groups[0]!; const value = settingsDraft.ratios[currentShareType.id]?.[group.id] ?? 1; return <div key={group.id} className="setup-share-row"><p>{currentShareType.name}: a {group.name} does <input aria-label={`${currentShareType.name} share for ${group.name}`} type="number" min="0" step="0.25" value={value} onChange={event => setShareForGroup(currentShareType.id, group.id, Number(event.target.value))} /> sessions for every 1 a {baseline.name} does.</p><p>{shareSentence(group.name, baseline.name, currentShareType.name, value)}</p></div>; })}</> : <p>There are no Day types to set. On-call types always count as an equal share.</p>}<p className="small muted">Only Day types are included here. On-call types always count as an equal share.</p></div>}
    {step === 'minimums' && <div className="setup-wizard-step"><p>How many doctors must be at work each day, across the whole rota?</p><p>Day jobs, long days and half-day sessions count; nights, leave, training and zero days don't.</p><p>Find swaps warns when a swap or leave would leave fewer doctors than this. Fairer rota uses each place's own numbers in Staffing needs.</p><div className="swap-minimums">{weekdayNames.map((day, index) => <label className="field" key={day}>{day}<input type="number" min="0" value={minimumDraft.weekdays[index] || ''} placeholder="No minimum" onChange={event => { setMinimumDirty(true); setMinimumDraft(current => ({ ...current, weekdays: current.weekdays.map((value, i) => i === index ? Number(event.target.value) || 0 : value) })); }} /><small>Suggested {minSuggestions[index]}</small></label>)}<label className="field">Bank holiday<input type="number" min="0" value={minimumDraft.bankHoliday || ''} placeholder="No minimum" onChange={event => { setMinimumDirty(true); setMinimumDraft(current => ({ ...current, bankHoliday: Number(event.target.value) || 0 })); }} /><small>Suggested {minSuggestions[6]}</small></label></div><button type="button" onClick={() => { setMinimumDraft({ weekdays: minSuggestions, bankHoliday: minSuggestions[6]! }); setMinimumDirty(true); }}>Use the suggestions</button></div>}
    {step === 'rules' && <div className="setup-wizard-step">
      <p>Working-time limits are optional. Only add rules that fit your contract.</p>
      <button type="button" onClick={() => { setRuleDraft(applyNationalLimitRows(profile, ruleDraft)); setRuleDirty(true); }}>Use the national limits</button>
      <p className="small muted">From the 2016 terms and conditions for doctors in training (England), Schedule 03. Check them against your own contract.</p>
      {nationalLimitRows(profile).map(row => {
        const matched = activeNationalRule(ruleDraft, row);
        const numbers = matched ? ruleNumbers(matched, row.values) : [];
        return <div className="setup-rule-row" key={row.id}>
          <label><input type="checkbox" checked={!!matched && matched.enabled !== false} onChange={event => {
            const existing = activeNationalRule(ruleDraft, row);
            if (event.target.checked) setRuleDraft(current => [...current.filter(rule => rule.id !== existing?.id), structuredClone(row.rule)]);
            else setRuleDraft(current => current.filter(rule => rule.id !== existing?.id));
            setRuleDirty(true);
          }} />{row.title}</label>
          <span>{row.parts.map((part, index) => <span key={`${row.id}-${index}`}>{part} {index < row.values.length && <input type="number" min="0" value={numbers[index] ?? ''} aria-label={`${row.title} ${index + 1}`} disabled={!matched} onChange={event => changeLimitValue(row, index, Math.max(0, Number(event.target.value)))} />}</span>)}{row.hint && <small className="small muted">{row.hint}</small>}</span>
        </div>;
      })}
      <p className="small muted">Not checked by this app yet: shifts longer than 13 hours; late long shifts in a row; on-call limits.</p>
      <p className="small muted">Find swaps does not check weekend rules yet.</p>
    </div>}
    {medirotaOrigin && step !== 'welcome' && <p className="small"><a href={medirotaOrigin} target="_blank" rel="noreferrer">Open MediRota</a></p>}
    {step !== 'welcome' && step !== 'summary' && <footer className="setup-wizard-actions"><span>{step === 'types' && firstTimeDraft && !typesReady ? `Choose Day or On-call for: ${settingsDraft.types.filter(type => type.placeIds.length && unselectedKindIds.has(type.id)).map(type => type.name || 'new session type').join(', ')}` : ''}</span><button type="button" onClick={backFromShare}>Back</button>{['fetch', 'types', 'groups', 'shares', 'minimums', 'rules'].includes(step) && <button type="button" className="ghost" onClick={() => move('skip')}>{step === 'fetch' ? 'Skip for now' : 'Skip'}</button>}{step !== 'fetch' && <button type="button" className="primary" disabled={step === 'role' && !roleDraft || step === 'doctor' && !doctorDraft || step === 'types' && !typesReady} onClick={() => move('next')}>{step === 'bookmark' ? "I've added it" : step === 'rules' ? 'Finish setup' : 'Next'}</button>}</footer>}
  </section></div>;
}
