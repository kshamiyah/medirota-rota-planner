import { activityLooksLikeNote, type ImportPlan } from './mediImport';

export const SETUP_REVIEW_KEY = 'rota-planner.first-setup-review.v1';

export function saveSetupReview(plan: ImportPlan): void {
  try { localStorage.setItem(SETUP_REVIEW_KEY, JSON.stringify(plan)); } catch { /* the imported workspace remains usable if storage is full */ }
}

export function readSetupReview(): ImportPlan | undefined {
  try { const value = localStorage.getItem(SETUP_REVIEW_KEY); return value ? JSON.parse(value) as ImportPlan : undefined; } catch { return undefined; }
}

export function clearSetupReview(): void {
  try { localStorage.removeItem(SETUP_REVIEW_KEY); } catch { /* optional draft */ }
}

export function extraOnlyMediRotaIds(plan: ImportPlan): string[] {
  return plan.personWeeks.flatMap(week => week.people.flatMap(person => {
    const activities = Object.values(person.days).flatMap(sessions => Object.values(sessions).flat());
    return activities.length > 0 && activities.every(activity => /\[Extra\]\s*$/.test(activity)) ? [person.id] : [];
  })).filter((id, index, ids) => ids.indexOf(id) === index);
}

export function quickLookItems(plan: ImportPlan): { noGrade: number; unsortedActivities: string[]; extraOnly: string[] } {
  return {
    noGrade: plan.people.filter(person => person.action !== 'skip' && !person.grade).length,
    // Deliberate Not counted (placeholders, [Removed], notes, Available) stay silent; only genuine unknowns are listed.
    unsortedActivities: plan.activities.filter(activity => activity.treat === 'ignore' && !/^available$/i.test(activity.name) && !activityLooksLikeNote(activity.name)).map(activity => activity.name),
    extraOnly: extraOnlyMediRotaIds(plan),
  };
}
