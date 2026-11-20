/**
 * Setup tab title: "Rota Planner" while waiting; "✓ Rota Planner" once the rota arrives;
 * back to "Rota Planner" when setup finishes or is left.
 */
import './polyfill-storage';
import './polyfill-dom';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearPolyfillStorage } from './polyfill-storage';
import { SetupWizard } from '../src/app/pages/SetupWizard';
import { DEFAULT_SWAP_SETTINGS } from '../src/app/mediImport';
import { emptyWorkspace, replaceWorkspace } from '../src/app/store';

beforeEach(() => {
  clearPolyfillStorage();
  document.title = 'Rota Planner';
  replaceWorkspace(emptyWorkspace());
});

async function renderSetup(workspace = emptyWorkspace(), initialStep: 'fetch' | 'summary' = 'fetch') {
  replaceWorkspace(workspace);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as Element);
  let left = false;
  let finished = false;
  await act(async () => {
    root.render(createElement(SetupWizard, {
      mode: 'firstRun',
      initialStep,
      onFinish() { finished = true; },
      onLeave() { left = true; },
      onReviewDetails() {},
      onNavigate() {},
    }));
  });
  return { host, root, left: () => left, finished: () => finished };
}

function withRota() {
  const workspace = emptyWorkspace();
  workspace.profile.staff = [{ id: 'rowan', name: 'Dr Rowan', groupIds: [], fte: 1 }];
  workspace.swapFinder = {
    settings: structuredClone(DEFAULT_SWAP_SETTINGS),
    snapshot: { days: {}, importedAt: { '2026-11-16': '2026-11-15T12:00:00Z' } },
  };
  return workspace;
}

describe('Setup wizard tab title', () => {
  it('stays Rota Planner while waiting for the rota on the fetch step', async () => {
    const { root } = await renderSetup(emptyWorkspace(), 'fetch');
    expect(document.title).toBe('Rota Planner');
    await act(async () => { root.unmount(); });
    expect(document.title).toBe('Rota Planner');
  });

  it('sets ✓ Rota Planner when the rota arrives during setup, and clears it on leave', async () => {
    const { root } = await renderSetup(withRota(), 'fetch');
    expect(document.title).toBe('✓ Rota Planner');
    await act(async () => { root.unmount(); });
    expect(document.title).toBe('Rota Planner');
  });

  it('keeps ✓ Rota Planner on the summary step after the rota arrives', async () => {
    const { root } = await renderSetup(withRota(), 'summary');
    expect(document.title).toBe('✓ Rota Planner');
    await act(async () => { root.unmount(); });
    expect(document.title).toBe('Rota Planner');
  });
});
