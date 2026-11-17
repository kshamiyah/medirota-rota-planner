import { FETCH_CHANNEL, validWeekDates } from './fetchBookmark';

export type ProtocolMessage = { type: string; [key: string]: unknown; channel?: string };
export interface ProtocolEvent { origin: string; source: MessageEventSource | null; data: ProtocolMessage }
export interface MessagePort { postMessage(message: unknown, targetOrigin: string): void }

/** Bookmark-side handshake and fetch orchestration. */
export function createBookmarkProtocol(options: {
  appOrigin: string;
  appTab: MessagePort;
  appSource?: MessageEventSource;
  fetchPage: (date: string, view?: 'people' | 'activity') => Promise<{ status: number; html: string }>;
  onFallback: () => void;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  cancel?: (id: ReturnType<typeof setTimeout>) => void;
  pause?: (ms: number) => Promise<void>;
}) {
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;
  const pause = options.pause ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let accepted = false;
  const receive = async (event: ProtocolEvent) => {
    const msg = event.data;
    if (event.origin !== options.appOrigin || event.source !== (options.appSource ?? options.appTab) || msg.channel !== FETCH_CHANNEL) return false;
    if (msg.type === 'rota-planner-ready') {
      if (timer) { cancel(timer); timer = undefined; }
      accepted = true;
      // The generated bookmark responds to this ready message with hello.
      return true;
    }
    if (msg.type === 'stop' && accepted) { stopped = true; return true; }
    if (msg.type !== 'fetch' || !accepted || !validWeekDates(msg.dates)) return false;
    stopped = false;
    let requestCount = 0;
    const request = async (date: string, view: 'people' | 'activity') => {
      if (requestCount++ > 0 && !stopped) await pause(1000);
      if (stopped) return undefined;
      return options.fetchPage(date, view);
    };
    for (let i = 0; i < msg.dates.length && !stopped; i++) {
      const start = msg.dates[i];
      try {
        const result = await request(start, 'people');
        const activity = await request(start, 'activity');
        if (result && activity && !stopped) options.appTab.postMessage({ channel: FETCH_CHANNEL, type: 'week', start, status: result.status, html: result.html, activityStatus: activity.status, activityHtml: activity.html }, options.appOrigin);
      } catch (error) {
        options.appTab.postMessage({ channel: FETCH_CHANNEL, type: 'error', start, message: String(error) }, options.appOrigin);
      }
    }
    options.appTab.postMessage({ channel: FETCH_CHANNEL, type: 'done' }, options.appOrigin);
    return true;
  };
  timer = schedule(() => { if (!accepted) options.onFallback(); }, 10_000);
  return { receive, dispose: () => { if (timer) cancel(timer); }, get accepted() { return accepted; } };
}

/** Planner-side trust check and incoming data handler. */
export function createPlannerProtocol(options: {
  source: MessageEventSource;
  reply: MessagePort;
  isTrusted: (origin: string) => boolean;
  confirmTrust: (origin: string) => boolean;
  saveTrust: (origin: string) => void;
  onMessage: (message: ProtocolMessage) => void;
}) {
  let accepted = false;
  let helloHandled = false;
  const receive = (event: ProtocolEvent) => {
    const message = event.data;
    if (message.channel !== FETCH_CHANNEL || event.source !== options.source) return false;
    if (message.type === 'hello') {
      if (helloHandled) return false;
      if (!options.isTrusted(event.origin)) {
        if (!options.confirmTrust(event.origin)) return false;
        options.saveTrust(event.origin);
      }
      accepted = true;
      helloHandled = true;
      return true;
    }
    if (!accepted || !options.isTrusted(event.origin)) return false;
    if (['week', 'error', 'done'].includes(message.type)) options.onMessage(message);
    return ['week', 'error', 'done'].includes(message.type);
  };
  return { receive };
}
