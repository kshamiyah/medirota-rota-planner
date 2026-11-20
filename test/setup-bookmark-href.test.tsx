/**
 * Setup wizard draggable bookmark must keep a real javascript: href after effects.
 * React blocks javascript: in href props; FetchBookmarkLink sets it via setAttribute.
 */
import './polyfill-storage';
import './polyfill-dom';
import { createElement, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearPolyfillStorage } from './polyfill-storage';
import { findAnchors } from './polyfill-dom';
import { SetupWizard } from '../src/app/pages/SetupWizard';
import { emptyWorkspace, replaceWorkspace } from '../src/app/store';

beforeEach(() => {
  clearPolyfillStorage();
  replaceWorkspace(emptyWorkspace());
});

async function renderWizard(initialStep: 'bookmark' | 'finish') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root: Root = createRoot(host as unknown as Element);
  await act(async () => {
    root.render(createElement(SetupWizard, {
      mode: 'firstRun',
      initialStep,
      onFinish() {},
      onLeave() {},
      onReviewDetails() {},
      onNavigate() {},
    }));
  });
  return { host, root };
}

function assertBookmarkHref(href: string | null | undefined) {
  expect(typeof href === 'string' && href.length > 0).toBe(true);
  const value = String(href);
  expect(value.startsWith('javascript:')).toBe(true);
  expect(value.includes('rota-planner-fetch')).toBe(true);
  expect(value.includes('React has blocked')).toBe(false);
}

describe('Setup wizard bookmark href', () => {
  it('keeps a real javascript: bookmark on the Add the bookmark step', async () => {
    const { host, root } = await renderWizard('bookmark');
    const links = findAnchors(host as never).filter(a => (a.textContent || '').includes('Fetch from MediRota'));
    expect(links.length).toBeGreaterThan(0);
    assertBookmarkHref(links[0]!.getAttribute('href'));
    await act(async () => { root.unmount(); });
  });

  it('keeps a real javascript: bookmark on the finish screen without an import', async () => {
    const { host, root } = await renderWizard('finish');
    const links = findAnchors(host as never).filter(a => (a.textContent || '').includes('Fetch from MediRota'));
    expect(links.length).toBeGreaterThan(0);
    assertBookmarkHref(links[0]!.getAttribute('href'));
    await act(async () => { root.unmount(); });
  });
});
