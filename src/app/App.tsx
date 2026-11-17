import { useEffect, useRef, useState } from 'react';
import { getWorkspace, hasSavedWorkspace, useWorkspace } from './store';
import { Shifts } from './pages/Shifts';
import { Places } from './pages/Places';
import { Staffing } from './pages/Staffing';
import { People } from './pages/People';
import { Rules } from './pages/Rules';
import { Import } from './pages/Import';
import type { Page } from './pages/types';
import { ICONS, SidebarIcon } from './components/Icons';
import { FindSwaps } from './pages/FindSwaps';
import { SwapSettingsPage } from './pages/SwapSettings';
import { Overview, ViewingAs } from './pages/Overview';
import { SettingsPage } from './pages/Settings';
import { Sessions } from './pages/Sessions';
import type { SettingsSection } from './pages/Settings';
import { FairerRota } from './pages/FairerRota';
import { SetupWizard } from './pages/SetupWizard';
import { fetchFromMediRotaWizardStep, shouldShowSetupWizard, type SetupWizardStep } from './setupWizard';

export const SETUP_DONE_KEY = 'rota-planner.setup-wizard-done.v1';
export function dismissedSetupWizard(): boolean { try { return localStorage.getItem(SETUP_DONE_KEY) === 'yes'; } catch { return false; } }

const NAV: { section: string; items: { id: Page; label: string }[] }[] = [
  { section: '', items: [{ id: 'overview', label: 'Overview' }, { id: 'sessions', label: 'Sessions' }, { id: 'swaps', label: 'Find swaps' }, { id: 'fairer', label: 'Fairer rota' }] },
  { section: 'Workspace', items: [{ id: 'import', label: 'Update from MediRota' }, { id: 'settings', label: 'Settings' }] },
];

function hasImportedRota(workspace = getWorkspace()): boolean {
  return Object.keys(workspace.swapFinder?.snapshot.importedAt ?? {}).length > 0;
}

export function App() {
  const ws = useWorkspace();
  const fetchFromMediRota = new URLSearchParams(location.search).get('fetchFromMediRota') === '1';
  const [wizardMode, setWizardMode] = useState<'firstRun' | 'rerun' | null>(() => !fetchFromMediRota && !dismissedSetupWizard() && shouldShowSetupWizard(getWorkspace(), hasSavedWorkspace()) ? 'firstRun' : null);
  const [wizardInitialStep, setWizardInitialStep] = useState<SetupWizardStep>('role');
  const [wizardEpoch, setWizardEpoch] = useState(0);
  const [page, setPage] = useState<Page>(() => fetchFromMediRota ? 'import' : wizardMode ? 'setup' : 'overview');
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('you');
  const fetchWizardOpened = useRef(false);
  useEffect(() => {
    if (!fetchFromMediRota || dismissedSetupWizard() || fetchWizardOpened.current || !hasImportedRota(ws)) return;
    fetchWizardOpened.current = true;
    // Setup is not dismissed here: treat this as first-time setup so Next saves on-screen suggestions.
    setWizardMode(current => current ?? 'firstRun');
    setWizardInitialStep(fetchFromMediRotaWizardStep(ws.role));
    setWizardEpoch(value => value + 1);
    setPage('setup');
  }, [fetchFromMediRota, ws]);
  const finishSetup = () => {
    try { localStorage.setItem(SETUP_DONE_KEY, 'yes'); } catch { /* in-memory setup remains available */ }
    setWizardMode(null); setPage('overview');
  };
  const runSetupAgain = () => { setWizardMode('rerun'); setWizardInitialStep('role'); setWizardEpoch(value => value + 1); setPage('setup'); };
  // The sidebar can shrink to a strip of icons; remembered in this browser.
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem('rota-planner.sidebar') === 'collapsed'; } catch { return false; } });
  const toggleSidebar = () => setCollapsed(c => {
    try { localStorage.setItem('rota-planner.sidebar', c ? 'open' : 'collapsed'); } catch { /* storage unavailable */ }
    return !c;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === '\\') { e.preventDefault(); toggleSidebar(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const counts: Partial<Record<Page, number>> = {
    shifts: ws.profile.shiftTypes.length, places: ws.profile.roles.filter(r => !r.parentId).length, rules: ws.profile.rules.length, people: ws.profile.staff.length,
  };
  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <nav className="sidebar" aria-label="Main">
        <div className="brand">
          <span className="brand-name">Rota Planner</span>
          <button className="sidebar-toggle" onClick={toggleSidebar} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!collapsed}
            title={collapsed ? 'Expand sidebar (⌘\\)' : 'Collapse sidebar (⌘\\)'}><SidebarIcon /></button>
        </div>
        {NAV.map(sec => (
          <div key={sec.section}>
            {sec.section && <div className="nav-section">{sec.section}</div>}
            {sec.items.map(it => (
              <button key={it.id} className={`nav-item ${page === it.id ? 'active' : ''}`} onClick={() => setPage(it.id)} aria-current={page === it.id ? 'page' : undefined}
                title={collapsed ? it.label : undefined} aria-label={collapsed ? it.label : undefined}>
                {ICONS[it.id as keyof typeof ICONS]}<span className="nav-label">{it.label}</span>{counts[it.id] !== undefined && <span className="count">{counts[it.id]}</span>}
              </button>
            ))}
          </div>
        ))}
        <div className="sidebar-footer small muted">
          <span>Saved in this browser</span>
        </div>
      </nav>
      <main className="main">
        {ws.role !== 'coordinator' && page !== 'swaps' && page !== 'swapSettings' && page !== 'setup' && page !== 'settings' && <ViewingAs />}
        {page === 'overview' && <Overview go={setPage} openPresets={() => { setSettingsSection('files'); setPage('settings'); }} />}
        {page === 'sessions' && <Sessions go={setPage} />}
        {page === 'fairer' && <FairerRota go={setPage} openSessions={() => { setSettingsSection('sessions'); setPage('settings'); }} />}
        {page === 'settings' && <SettingsPage go={setPage} initialSection={settingsSection} onSectionChange={setSettingsSection} onRunSetup={runSetupAgain} returnToSetup={wizardMode !== null ? () => setPage('setup') : undefined} />}
        {page === 'import' && <Import go={setPage} />}
        {page === 'shifts' && <Shifts />}
        {page === 'places' && <Places />}
        {page === 'staffing' && <Staffing />}
        {page === 'rules' && <Rules />}
        {page === 'people' && <People />}
        {wizardMode && <div hidden={page !== 'setup'}><SetupWizard key={`${wizardMode}-${wizardEpoch}`} mode={wizardMode} initialStep={wizardInitialStep} go={nextPage => { if (nextPage === 'settings') setSettingsSection('people'); setPage(nextPage); }} onFinish={finishSetup} /></div>}
        {page === 'swaps' && <FindSwaps go={setPage} />}
        {page === 'swapSettings' && <SwapSettingsPage go={setPage} />}
      </main>
    </div>
  );
}
