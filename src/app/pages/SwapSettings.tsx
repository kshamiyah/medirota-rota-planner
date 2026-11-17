import { Empty, PageHead } from '../components/ui';
import { update, useWorkspace } from '../store';
import { SwapSettingsPanel } from './FindSwaps';
import type { Page } from './types';
import { markPresetPersonOverride, resolvePresetPeople } from '../presets';

export function SwapSettingsPage({ go }: { go: (page: Page) => void }) {
  const ws = useWorkspace();
  const data = ws.swapFinder;
  const unmatched = ws.presetPeople ? resolvePresetPeople(ws.presetPeople.people, ws.profile.staff) : { unmatched: [], ambiguous: [] };
  if (!data) return <><PageHead title="Swap settings">Set the department defaults used by Find swaps.</PageHead><Empty><h2>Import a rota first</h2><button type="button" onClick={() => go('import')}>Import from MediRota</button></Empty></>;
  return (
    <>
      <PageHead title="Swap settings">Department settings saved with this workspace.</PageHead>
      <p><button type="button" className="link-button" onClick={() => go('swaps')}>Back to Find swaps</button></p>
      {unmatched.unmatched.length > 0 && <details className="card"><summary>{unmatched.unmatched.length} {unmatched.unmatched.length === 1 ? 'person' : 'people'} in the preset {unmatched.unmatched.length === 1 ? 'isn’t' : 'aren’t'} on this rota</summary><p className="small">{unmatched.unmatched.join(', ')}</p></details>}
      {unmatched.ambiguous.length > 0 && <details className="card"><summary>{unmatched.ambiguous.length} preset {unmatched.ambiguous.length === 1 ? 'name has' : 'names have'} more than one match</summary><p className="small">{unmatched.ambiguous.join(', ')}. These settings have not been applied.</p></details>}
      <SwapSettingsPanel settings={data.settings} staff={ws.profile.staff} snapshot={data.snapshot} save={(mutate, override) => update(draft => {
        if (!draft.swapFinder) return;
        mutate(draft.swapFinder.settings);
        if (override) {
          const name = draft.profile.staff.find(person => person.id === override.staffId)?.name;
          if (name) {
            const value = override.field === 'excludeFromSwaps'
              ? draft.swapFinder.settings.excluded.some(entry => entry.staffId === override.staffId)
              : [...(draft.swapFinder.settings.regularDaysOff[override.staffId] ?? [])];
            markPresetPersonOverride(draft, name, override.field, value);
          }
        }
      })} />
    </>
  );
}
