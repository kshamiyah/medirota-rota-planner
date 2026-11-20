import { useEffect, useState } from 'react';
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
import { shouldOpenFetchTabSetup, shouldShowSetupWizard } from './setupWizard';
import { clearSetupReview } from './setupReview';
import { clearSetupStep, savedSetupStep, SETUP_PROGRESS_KEY } from './pages/SetupWizard';

export const SETUP_DONE_KEY = 'rota-planner.setup-wizard-done.v1';
export function dismissedSetupWizard(): boolean { try { return localStorage.getItem(SETUP_DONE_KEY) === 'yes'; } catch { return false; } }

const NAV: { section: string; items: { id: Page; label: string }[] }[] = [
  { section: '', items: [{ id: 'overview', label: 'Overview' }, { id: 'sessions', label: 'Sessions' }, { id: 'swaps', label: 'Find swaps' }, { id: 'fairer', label: 'Fairer rota' }] },
  { section: 'Workspace', items: [{ id: 'import', label: 'Update from MediRota' }, { id: 'settings', label: 'Settings' }] },
];

export function App() {
  const ws = useWorkspace();
  const fetchFromMediRota = new URLSearchParams(location.search).get('fetchFromMediRota') === '1';
  const hasProgress = (() => { try { return !!localStorage.getItem(SETUP_PROGRESS_KEY); } catch { return false; } })();
  const [fetchTabNeedsSetup] = useState(() => fetchFromMediRota && shouldOpenFetchTabSetup(getWorkspace(), dismissedSetupWizard(), hasProgress));
  const [wizardMode, setWizardMode] = useState<'firstRun' | 'rerun' | null>(() => {
    if (fetchFromMediRota || dismissedSetupWizard()) return null;
    if (hasProgress) return 'firstRun';
    return shouldShowSetupWizard(getWorkspace(), hasSavedWorkspace()) ? 'firstRun' : null;
  });
  const [wizardInitialStep, setWizardInitialStep] = useState(savedSetupStep);
  const [wizardEpoch, setWizardEpoch] = useState(0);
  const [page, setPage] = useState<Page>(() => fetchFromMediRota ? 'import' : wizardMode ? 'setup' : 'overview');
  // Banner is for leaving mid-setup in this session; a reload reopens the wizard from the progress key.
  const [resumeAvailable, setResumeAvailable] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('you');
  const [settingsAnchor, setSettingsAnchor] = useState('');
  const openSessionSettings = (anchor: string) => { setSettingsSection('sessions'); setSettingsAnchor(anchor); setPage('settings'); };
  useEffect(() => { if (page !== 'settings') setSettingsAnchor(''); }, [page]);
  const finishSetup = () => {
    try { localStorage.setItem(SETUP_DONE_KEY, 'yes'); } catch { /* in-memory setup remains available */ }
    clearSetupStep(); clearSetupReview(); setResumeAvailable(false);
    setWizardMode(null); setPage('overview');
  };
  const leaveSetup = () => { setWizardMode(null); setPage('overview'); setResumeAvailable(!dismissedSetupWizard()); };
  const resumeSetup = () => { setWizardMode('firstRun'); setWizardInitialStep(savedSetupStep()); setWizardEpoch(value => value + 1); setPage('setup'); setResumeAvailable(false); };
  const runSetupAgain = () => { setWizardMode('rerun'); setWizardInitialStep('welcome'); setWizardEpoch(value => value + 1); setPage('setup'); };
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
    <div className={`app ${collapsed ? 'collapsed' : ''} ${wizardMode && page === 'setup' ? 'setup-fullscreen' : ''} ${fetchFromMediRota ? 'fetch-tab-app' : ''}`}>
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
        {resumeAvailable && !fetchFromMediRota && !wizardMode && !dismissedSetupWizard() && <div className="notice setup-resume-banner"><span>Finish setting up</span><button type="button" onClick={resumeSetup}>Resume setup</button></div>}
        {ws.role !== 'coordinator' && !fetchFromMediRota && page !== 'swaps' && page !== 'swapSettings' && page !== 'setup' && page !== 'settings' && <ViewingAs />}
        {page === 'overview' && <Overview go={setPage} openPresets={() => { setSettingsSection('files'); setPage('settings'); }} />}
        {page === 'sessions' && <Sessions go={setPage} openComparisonGroups={() => openSessionSettings('comparison-groups')} />}
        {page === 'fairer' && <FairerRota go={setPage} openSessions={anchor => openSessionSettings(anchor)} />}
        {page === 'settings' && <SettingsPage go={setPage} initialSection={settingsSection} initialAnchor={settingsAnchor} onSectionChange={section => { setSettingsSection(section); setSettingsAnchor(''); }} onRunSetup={runSetupAgain} returnToSetup={wizardMode !== null ? () => setPage('setup') : undefined} />}
        {page === 'import' && <Import go={next => setPage(next)} showFetchDone={!fetchTabNeedsSetup} firstTimeFetch={fetchTabNeedsSetup} setupReview={!!wizardMode && page === 'import'} onReturnToSetup={() => setPage('setup')} />}
        {page === 'shifts' && <Shifts />}
        {page === 'places' && <Places />}
        {page === 'staffing' && <Staffing />}
        {page === 'rules' && <Rules />}
        {page === 'people' && <People />}
        {wizardMode && <div hidden={page !== 'setup'}><SetupWizard key={`${wizardMode}-${wizardEpoch}`} mode={wizardMode} initialStep={wizardInitialStep} onFinish={finishSetup} onLeave={leaveSetup} onReviewDetails={() => setPage('import')} onNavigate={nextPage => setPage(nextPage)} /></div>}
        {page === 'swaps' && <FindSwaps go={next => { if (next === 'rules') { setSettingsSection('rules'); setSettingsAnchor(''); setPage('settings'); } else setPage(next); }} />}
        {page === 'swapSettings' && <SwapSettingsPage go={setPage} />}
      </main>
    </div>
  );
}
