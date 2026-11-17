import { describe, expect, it, vi } from 'vitest';
import { FETCH_CHANNEL } from '../src/app/fetchBookmark';
import { createBookmarkProtocol, createPlannerProtocol, type ProtocolEvent } from '../src/app/fetchProtocol';
const origin = 'http://127.0.0.1:5173';
const fakeTab = {} as MessageEventSource;
const event = (type: string, source: MessageEventSource = fakeTab, eventOrigin = origin, extra: Record<string, unknown> = {}): ProtocolEvent => ({ origin: eventOrigin, source, data: { channel: FETCH_CHANNEL, type, ...extra } });
describe('fetch message handshake', () => {
  it('sends hello only after ready from the built-in app origin and opened tab', async () => {
    const postMessage = vi.fn(), protocol = createBookmarkProtocol({ appOrigin: origin, appTab: { postMessage }, appSource: fakeTab, fetchPage: async () => ({ status: 200, html: '' }), onFallback: vi.fn(), schedule: (() => setTimeout(() => {}, 60_000)), cancel: vi.fn() });
    expect(await protocol.receive(event('rota-planner-ready'))).toBe(true);
    expect(protocol.accepted).toBe(true);
    expect(postMessage).not.toHaveBeenCalled();
    protocol.dispose();
  });
  it('ignores untrusted origins and wrong window sources', async () => {
    const postMessage = vi.fn(), protocol = createBookmarkProtocol({ appOrigin: origin, appTab: { postMessage }, appSource: fakeTab, fetchPage: async () => ({ status: 200, html: '' }), onFallback: vi.fn() });
    await protocol.receive(event('rota-planner-ready', fakeTab, 'http://evil.test'));
    await protocol.receive(event('rota-planner-ready', {} as MessageEventSource));
    expect(protocol.accepted).toBe(false); expect(postMessage).not.toHaveBeenCalled(); protocol.dispose();
  });
  it('cancels the fallback timer when ready arrives', async () => {
    const cancel = vi.fn(), onFallback = vi.fn(), protocol = createBookmarkProtocol({ appOrigin: origin, appTab: { postMessage: vi.fn() }, appSource: fakeTab, fetchPage: async () => ({ status: 200, html: '' }), onFallback, schedule: (() => setTimeout(() => {}, 60_000)), cancel });
    await protocol.receive(event('rota-planner-ready')); expect(cancel).toHaveBeenCalled(); protocol.dispose(); expect(onFallback).not.toHaveBeenCalled();
  });
  it('fetches weeks in order, sends done, and stops between pages', async () => {
    const sent: unknown[] = [], fetched: string[] = [], pauses: number[] = [], postMessage = vi.fn(message => sent.push(message)), protocol = createBookmarkProtocol({ appOrigin: origin, appTab: { postMessage }, appSource: fakeTab, fetchPage: async (date, view) => { fetched.push(`${date}:${view}`); return { status: 200, html: `<html>${view}</html>` }; }, onFallback: vi.fn(), pause: async ms => { pauses.push(ms); } });
    await protocol.receive(event('rota-planner-ready')); await protocol.receive(event('fetch', fakeTab, origin, { dates: ['2026-11-02', '2026-11-09'] }));
    expect(fetched).toEqual(['2026-11-02:people', '2026-11-02:activity', '2026-11-09:people', '2026-11-09:activity']);
    expect(pauses).toEqual([1000, 1000, 1000]);
    expect(sent).toContainEqual(expect.objectContaining({ type: 'week', start: '2026-11-02', html: '<html>people</html>', activityHtml: '<html>activity</html>' })); expect(sent).toContainEqual(expect.objectContaining({ type: 'done' })); protocol.dispose();
    const fetchPage = vi.fn(async () => ({ status: 200, html: '' })), stoppable = createBookmarkProtocol({ appOrigin: origin, appTab: { postMessage: vi.fn() }, appSource: fakeTab, fetchPage, onFallback: vi.fn(), pause: () => new Promise(resolve => setTimeout(resolve, 5)) });
    await stoppable.receive(event('rota-planner-ready')); const running = stoppable.receive(event('fetch', fakeTab, origin, { dates: ['2026-11-02', '2026-11-09'] })); await stoppable.receive(event('stop')); await running; expect(fetchPage).toHaveBeenCalledTimes(1); stoppable.dispose();
  });
  it('trusts hello from the opened MediRota source, then rejects spoofed week messages', () => {
    const saveTrust = vi.fn(), onMessage = vi.fn(), reply = { postMessage: vi.fn() }, protocol = createPlannerProtocol({ source: fakeTab, reply, isTrusted: () => false, confirmTrust: () => true, saveTrust, onMessage });
    expect(protocol.receive(event('hello'))).toBe(true); expect(saveTrust).toHaveBeenCalledWith(origin); expect(reply.postMessage).not.toHaveBeenCalled(); expect(protocol.receive(event('hello'))).toBe(false);
    expect(protocol.receive(event('week', {} as MessageEventSource))).toBe(false); expect(protocol.receive(event('week', fakeTab, 'http://evil.test'))).toBe(false);
  });
});
