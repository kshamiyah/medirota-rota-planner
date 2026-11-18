/**
 * Independent checks for the MediRota fetch bookmark. A failure is left failing.
 */
import vm from 'node:vm';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { formatDateLong } from '../src/app/components/ui';
import { appUrl as buildAppUrl, FETCH_CHANNEL, makeFetchBookmark, validWeekDates } from '../src/app/fetchBookmark';
import { createBookmarkProtocol, createPlannerProtocol, type ProtocolEvent } from '../src/app/fetchProtocol';

const appOrigin = 'http://127.0.0.1:5173';
const appUrl = `${appOrigin}/`;
const tab = {};
const opener = {};

function mondays(count: number, start = '2026-11-02'): string[] {
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(`${start}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + index * 7);
    return date.toISOString().slice(0, 10);
  });
}

describe('fetch protocol', () => {
  it('asks about trust at most once per opener and never replies ready', () => {
    const prompts: string[] = [];
    const replies: string[] = [];
    const weeks: string[] = [];
    let trusted = false;
    const planner = createPlannerProtocol({
      source: opener as never,
      reply: { postMessage(message: { type: string }) { replies.push(message.type); } },
      isTrusted: () => trusted,
      confirmTrust: origin => { prompts.push(origin); return true; },
      saveTrust: () => { trusted = true; },
      onMessage: message => weeks.push(message.type),
    });
    const hello: ProtocolEvent = { origin: 'http://127.0.0.1:9', source: opener as never, data: { channel: FETCH_CHANNEL, type: 'hello' } };
    expect(planner.receive(hello)).toBe(true);
    expect(planner.receive(hello)).toBe(false);
    expect(prompts).toEqual(['http://127.0.0.1:9']);
    expect(replies).toEqual([]);
    expect(planner.receive({ origin: 'http://127.0.0.1:9', source: opener as never, data: { channel: FETCH_CHANNEL, type: 'week', start: '2026-11-02', status: 200, html: '<html></html>' } })).toBe(true);
    expect(weeks).toEqual(['week']);
  });

  it('ignores an untrusted origin and the wrong window', async () => {
    const posted: unknown[] = [];
    const bookmark = createBookmarkProtocol({
      appOrigin,
      appSource: tab as never,
      appTab: { postMessage(message) { posted.push(message); } },
      fetchPage: async () => ({ status: 200, html: '' }),
      onFallback: () => posted.push('fallback'),
      schedule: () => 1 as never,
      cancel: () => {},
    });
    const wrongWindow: ProtocolEvent = { origin: appOrigin, source: {} as never, data: { channel: FETCH_CHANNEL, type: 'rota-planner-ready' } };
    const wrongOrigin: ProtocolEvent = { origin: 'http://evil.test', source: tab as never, data: { channel: FETCH_CHANNEL, type: 'rota-planner-ready' } };
    expect(await bookmark.receive(wrongWindow)).toBe(false);
    expect(await bookmark.receive(wrongOrigin)).toBe(false);
    expect(bookmark.accepted).toBe(false);
    expect(posted).toEqual([]);
    bookmark.dispose();

    const saved: string[] = [];
    const seen: string[] = [];
    const planner = createPlannerProtocol({
      source: opener as never,
      reply: { postMessage() { seen.push('reply'); } },
      isTrusted: () => false,
      confirmTrust: () => false,
      saveTrust: origin => saved.push(origin),
      onMessage: message => seen.push(message.type),
    });
    expect(planner.receive({ origin: 'http://evil.test', source: opener as never, data: { channel: FETCH_CHANNEL, type: 'hello' } })).toBe(false);
    expect(planner.receive({ origin: 'http://127.0.0.1:9', source: {} as never, data: { channel: FETCH_CHANNEL, type: 'hello' } })).toBe(false);
    expect(planner.receive({ origin: 'http://evil.test', source: opener as never, data: { channel: FETCH_CHANNEL, type: 'week', html: '<html>' } })).toBe(false);
    expect(saved).toEqual([]);
    expect(seen).toEqual([]);
  });

  it('refuses a non-Monday, a non-date and 61 dates', () => {
    expect(validWeekDates(['2026-11-03'])).toBe(false);
    expect(validWeekDates(['not-a-date'])).toBe(false);
    expect(validWeekDates(['2026-02-30'])).toBe(false);
    expect(validWeekDates(mondays(61))).toBe(false);
    expect(validWeekDates(mondays(60))).toBe(true);
  });

  it('runs the 10 second fallback only when ready never arrives', async () => {
    const scheduled: (() => void)[] = [];
    let fallbacks = 0;
    const fetched: string[] = [];
    const late = createBookmarkProtocol({
      appOrigin,
      appSource: tab as never,
      appTab: { postMessage() {} },
      fetchPage: async (date, view) => { fetched.push(`${date}:${view}`); return { status: 200, html: '' }; },
      onFallback: () => { fallbacks += 1; },
      schedule: fn => { scheduled.push(fn); return scheduled.length as never; },
      cancel: () => {},
      pause: async () => {},
    });
    await late.receive({ origin: appOrigin, source: tab as never, data: { channel: FETCH_CHANNEL, type: 'rota-planner-ready' } });
    scheduled[0]?.();
    await late.receive({ origin: appOrigin, source: tab as never, data: { channel: FETCH_CHANNEL, type: 'fetch', dates: ['2026-11-02'] } });
    expect(fallbacks).toBe(0);
    expect(fetched).toEqual(['2026-11-02:people', '2026-11-02:activity']);
    late.dispose();

    let missed = 0;
    const quiet = createBookmarkProtocol({
      appOrigin,
      appSource: tab as never,
      appTab: { postMessage() {} },
      fetchPage: async () => ({ status: 200, html: '' }),
      onFallback: () => { missed += 1; },
      schedule: fn => { scheduled.push(fn); return 1 as never; },
      cancel: () => {},
    });
    scheduled.at(-1)?.();
    expect(missed).toBe(1);
    quiet.dispose();
  });
});

describe('date wording', () => {
  it('formats a Monday as Mon 2 Nov with no comma', () => {
    expect(formatDateLong('2026-11-02')).toBe('Mon 2 Nov');
    expect(formatDateLong('2027-08-30')).toBe('Mon 30 Aug');
  });
});

describe('app URL', () => {
  it('uses the origin and root base URL for local use', () => {
    expect(buildAppUrl('http://127.0.0.1:5180', '/')).toBe('http://127.0.0.1:5180/');
  });

  it('uses the origin and sub-folder base URL on GitHub Pages', () => {
    expect(buildAppUrl('https://kshamiyah.github.io', '/medirota-rota-planner/')).toBe('https://kshamiyah.github.io/medirota-rota-planner/');
  });
});

describe('generated bookmark', () => {
  async function boot(pathname = '/dept/rota/2026-11-02/people/', targetAppUrl = appUrl, deferFetch = false) {
    const fetches: string[] = [];
    const posted: { type: string }[] = [];
    const postTargets: string[] = [];
    const openedUrls: string[] = [];
    const openedNames: string[] = [];
    const prompts: string[] = [];
    const blobs: string[] = [];
    const requestSignals: AbortSignal[] = [];
    const pendingFetches: (() => void)[] = [];
    let fallback: (() => void) | undefined;
    const listeners: ((event: { origin: string; source: unknown; data: { channel?: string; type?: string; dates?: string[] } }) => Promise<void> | void)[] = [];
    const activeListeners = new Set<(typeof listeners)[number]>();
    const opened = { postMessage(message: { type: string }, targetOrigin: string) { posted.push(message); postTargets.push(targetOrigin); } };
    const sandbox = {
      location: { pathname },
      window: { open: (url: string, name: string) => { openedUrls.push(url); openedNames.push(name); return opened; } },
      alert() {},
      prompt(label: string) { prompts.push(label); return prompts.length === 1 ? '2026-11-02' : '2026-11-09'; },
      fetch: async (url: string, options?: { signal?: AbortSignal }) => { fetches.push(String(url)); if (options?.signal) requestSignals.push(options.signal); return new Promise<{ status: number; text: () => Promise<string> }>(resolve => { pendingFetches.push(() => resolve({ status: 200, text: async () => '<html></html>' })); if (!deferFetch) pendingFetches.at(-1)?.(); }); },
      setTimeout(fn: () => void, ms: number) {
        if (ms >= 10_000) { fallback = fn; return 1; }
        queueMicrotask(fn);
        return 2;
      },
      clearTimeout() {},
      addEventListener(_type: string, fn: (typeof listeners)[number]) { listeners.push(fn); activeListeners.add(fn); },
      removeEventListener(_type: string, fn: (typeof listeners)[number]) { activeListeners.delete(fn); },
      AbortController,
      document: { createElement: () => ({ click() {}, remove() {} }), body: { append() {} } },
      Blob: class { constructor(parts: string[]) { blobs.push(parts[0]); } },
      URL: class URL {
        static createObjectURL() { return 'blob:test'; }
        static revokeObjectURL() {}
        origin: string;
        constructor(value: string) { this.origin = new NodeURL(value).origin; }
      },
      JSON, Date, Promise, Array, Object, String, RegExp,
    };
    vm.createContext(sandbox);
    const click = async () => vm.runInContext(makeFetchBookmark(targetAppUrl).slice('javascript:'.length), sandbox);
    await click();
    const send = (data: { type: string; dates?: string[] }, origin = appOrigin, eventSource: unknown = opened) => [...activeListeners][0]?.({ origin, source: eventSource, data: { channel: FETCH_CHANNEL, ...data } });
    return { fetches, posted, postTargets, openedUrls, openedNames, prompts, blobs, requestSignals, send, click, activeListenerCount: () => activeListeners.size, releaseFetches: () => pendingFetches.splice(0).forEach(resolve => resolve()), fireFallback: () => fallback?.() };
  }

  it('answers the first ready with one hello, then sends the weeks and done', async () => {
    const bookmark = await boot();
    await bookmark.send({ type: 'rota-planner-ready' });
    await bookmark.send({ type: 'rota-planner-ready' });
    expect(bookmark.posted.map(message => message.type)).toEqual(['hello']);
    await bookmark.send({ type: 'fetch', dates: ['2026-11-02', '2026-11-09'] });
    expect(bookmark.posted.map(message => message.type)).toEqual(['hello', 'week', 'week', 'done']);
  });

  it('builds every fetch URL from its own page prefix', async () => {
    const bookmark = await boot('/dept/rota/2026-11-02/people/');
    await bookmark.send({ type: 'rota-planner-ready' });
    await bookmark.send({ type: 'fetch', dates: ['2026-11-09'] });
    expect(bookmark.fetches).toEqual(['/dept/rota/2026-11-09/people/', '/dept/rota/2026-11-09/']);
  });

  it('opens the hosted sub-folder with the fetch query and accepts messages only from its origin', async () => {
    const hostedUrl = buildAppUrl('https://kshamiyah.github.io', '/medirota-rota-planner/');
    const hostedOrigin = new URL(hostedUrl).origin;
    const bookmark = await boot('/dept/rota/2026-11-02/people/', hostedUrl);
    expect(bookmark.openedUrls).toEqual([`${hostedUrl}?fetchFromMediRota=1`]);
    expect(bookmark.openedNames).toEqual(['rota-planner-fetch']);
    await bookmark.send({ type: 'rota-planner-ready' }, 'https://evil.test');
    expect(bookmark.posted).toEqual([]);
    await bookmark.send({ type: 'rota-planner-ready' }, hostedOrigin);
    expect(bookmark.posted.map(message => message.type)).toEqual(['hello']);
    expect(bookmark.postTargets).toEqual([hostedOrigin]);
  });

  it('reuses one named fetch tab and one listener across two bookmark clicks', async () => {
    const bookmark = await boot();
    await bookmark.click();
    expect(bookmark.openedNames).toEqual(['rota-planner-fetch', 'rota-planner-fetch']);
    expect(bookmark.activeListenerCount()).toBe(1);
    await bookmark.send({ type: 'rota-planner-ready' });
    await bookmark.send({ type: 'fetch', dates: ['2026-11-02'] });
    expect(bookmark.fetches).toEqual(['/dept/rota/2026-11-02/people/', '/dept/rota/2026-11-02/']);
    expect(bookmark.posted.map(message => message.type)).toEqual(['hello', 'week', 'done']);
  });

  it('aborts a previous fetch when the bookmark is clicked again', async () => {
    const bookmark = await boot('/dept/rota/2026-11-02/people/', appUrl, true);
    await bookmark.send({ type: 'rota-planner-ready' });
    const running = bookmark.send({ type: 'fetch', dates: ['2026-11-02'] });
    await Promise.resolve();
    await bookmark.click();
    expect(bookmark.requestSignals[0]?.aborted).toBe(true);
    bookmark.releaseFetches();
    await running;
  });

  it('refuses a non-Monday, a non-date and 61 dates before fetching', async () => {
    const bookmark = await boot();
    await bookmark.send({ type: 'rota-planner-ready' });
    await bookmark.send({ type: 'fetch', dates: ['2026-11-03'] });
    await bookmark.send({ type: 'fetch', dates: ['not-a-date'] });
    await bookmark.send({ type: 'fetch', dates: ['2026-02-30'] });
    await bookmark.send({ type: 'fetch', dates: mondays(61) });
    expect(bookmark.fetches).toEqual([]);
  });

  it('does not fall back after ready, even if the owner waits more than 10 seconds to fetch', async () => {
    const bookmark = await boot();
    await bookmark.send({ type: 'rota-planner-ready' });
    bookmark.fireFallback();
    expect(bookmark.prompts).toEqual([]);
    await bookmark.send({ type: 'fetch', dates: ['2026-11-02'] });
    expect(bookmark.fetches).toEqual(['/dept/rota/2026-11-02/people/', '/dept/rota/2026-11-02/']);
  });

  it('falls back to one JSON bundle only when ready never arrives', async () => {
    const bookmark = await boot();
    bookmark.fireFallback();
    for (let step = 0; step < 30; step++) await new Promise(resolve => setTimeout(resolve, 0));
    expect(bookmark.prompts.length).toBe(2);
    expect(bookmark.fetches).toEqual(['/dept/rota/2026-11-02/people/', '/dept/rota/2026-11-02/', '/dept/rota/2026-11-09/people/', '/dept/rota/2026-11-09/']);
    const bundle = JSON.parse(bookmark.blobs[0]);
    expect(bundle.version).toBe(2);
    expect(bundle.weeks.map((week: { start: string }) => week.start)).toEqual(['2026-11-02', '2026-11-09']);
    expect(bundle.weeks.every((week: { html?: string; activityHtml?: string }) => typeof week.html === 'string' && typeof week.activityHtml === 'string')).toBe(true);
  });

  it('ignores ready from another origin or another window', async () => {
    const bookmark = await boot();
    await bookmark.send({ type: 'rota-planner-ready' }, 'http://evil.test');
    await bookmark.send({ type: 'rota-planner-ready' }, appOrigin, {});
    expect(bookmark.posted).toEqual([]);
  });
});
