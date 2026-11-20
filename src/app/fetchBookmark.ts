import type { PersonWeek } from './medirota';

export const FETCH_VERSION = 2;
export const MAX_FETCH_WEEKS = 60;
export const FETCH_CHANNEL = 'rota-planner-fetch';

export function appUrl(origin = location.origin, baseUrl = import.meta.env.BASE_URL): string {
  return `${origin}${baseUrl}`;
}

export type FetchMessage =
  | { type: 'rota-planner-ready'; version: number }
  | { type: 'fetch'; dates: string[] }
  | { type: 'week'; start: string; status: number; html: string; activityStatus?: number; activityHtml?: string }
  | { type: 'done' }
  | { type: 'error'; start: string; message: string };

export function validWeekDates(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_FETCH_WEEKS && value.every(d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d && new Date(`${d}T00:00:00Z`).getUTCDay() === 1);
}

export function snapToMonday(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) return date;
  const monday = new Date(`${date}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return monday.toISOString().slice(0, 10);
}

export function formatWeekOf(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  return Number.isNaN(value.getTime()) ? '' : `Week of ${value.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}`;
}

export function fetchWeekDates(start: string, end: string): string[] {
  const first = snapToMonday(start), last = snapToMonday(end);
  if (!validWeekDates([first, last]) || first > last) return [];
  const count = Math.floor((Date.parse(`${last}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / 604800000) + 1;
  if (count > MAX_FETCH_WEEKS) return [];
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(`${first}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + index * 7); return date.toISOString().slice(0, 10);
  });
}

/** Generates the self-contained bookmark. App URL is embedded for drag and copy. */
export function makeFetchBookmark(appUrl: string): string {
  const app = JSON.stringify(appUrl);
  const code = `(async()=>{
    const match=location.pathname.match(/^(.*\\/rota\\/)(\\d{4}-\\d{2}-\\d{2})(\\/people\\/?)$/);
    if(!match){alert('Open a MediRota "By person" week first, then click this bookmark again.');return;}
    const prefix=match[1],app=${app},appOrigin=new URL(app).origin,channel='${FETCH_CHANNEL}';
    const runKey='__rotaPlannerFetchRun';
    if(typeof window[runKey]==='function')window[runKey]();
    const tab=window.open(app+'?fetchFromMediRota=1','rota-planner-fetch');
    if(!tab){alert('Allow rota-planner to open a new tab, then click this bookmark again.');return;}
    let stopped=false,ready=false,helloSent=false,timeout;
    const controller=new AbortController();
    const valid=dates=>Array.isArray(dates)&&dates.length>0&&dates.length<=60&&dates.every(date=>typeof date==='string'&&/^\\d{4}-\\d{2}-\\d{2}$/.test(date)&&!Number.isNaN(Date.parse(date+'T00:00:00Z'))&&new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date&&new Date(date+'T00:00:00Z').getUTCDay()===1);
    const fallback=async()=>{
      const start=prompt('Start week (Monday, YYYY-MM-DD)'),end=prompt('End week (Monday, YYYY-MM-DD)');
      if(!start||!end)return;
      const first=new Date(start+'T00:00:00Z'),last=new Date(end+'T00:00:00Z'),dates=[];
      if(!/^\\d{4}-\\d{2}-\\d{2}$/.test(start)||!/^\\d{4}-\\d{2}-\\d{2}$/.test(end)||first>last||(last-first)/604800000>=60){alert('Choose up to 60 Monday weeks.');return;}
      for(let date=new Date(first);date<=last;date.setUTCDate(date.getUTCDate()+7))dates.push(date.toISOString().slice(0,10));
      const weeks=[];
      for(const date of dates){if(stopped)return;try{const response=await fetch(prefix+date+'/people/',{credentials:'same-origin',signal:controller.signal}),html=await response.text();await new Promise(resolve=>setTimeout(resolve,1000));if(stopped)return;const activity=await fetch(prefix+date+'/',{credentials:'same-origin',signal:controller.signal});weeks.push({start:date,status:response.status,html,activityStatus:activity.status,activityHtml:await activity.text()});}catch(error){if(!stopped)weeks.push({start:date,error:String(error)});}await new Promise(resolve=>setTimeout(resolve,1000));}
      if(stopped)return;
      const url=URL.createObjectURL(new Blob([JSON.stringify({version:2,weeks})],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download='rota-planner-fetch.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    };
    timeout=setTimeout(()=>{if(!ready)void fallback();},10000);
    const receive=async event=>{
      if(event.origin!==appOrigin||event.source!==tab||event.data?.channel!==channel)return;
      if(event.data.type==='rota-planner-ready'){
        ready=true;clearTimeout(timeout);
        if(!helloSent){helloSent=true;tab.postMessage({channel,type:'hello'},appOrigin);}
      } else if(event.data.type==='fetch'&&valid(event.data.dates)){
        clearTimeout(timeout);
        stopped=false;
        for(let i=0;i<event.data.dates.length&&!stopped;i++){
          const start=event.data.dates[i];
          try{const response=await fetch(prefix+start+'/people/',{credentials:'same-origin',signal:controller.signal}),html=await response.text();if(!stopped)await new Promise(resolve=>setTimeout(resolve,1000));if(stopped)break;const activity=await fetch(prefix+start+'/',{credentials:'same-origin',signal:controller.signal});if(!stopped)tab.postMessage({channel,type:'week',start,status:response.status,html,activityStatus:activity.status,activityHtml:await activity.text()},appOrigin);}
          catch(error){if(!stopped)tab.postMessage({channel,type:'error',start,message:String(error)},appOrigin);}
          if(i+1<event.data.dates.length&&!stopped)await new Promise(resolve=>setTimeout(resolve,1000));
        }
        if(!stopped)tab.postMessage({channel,type:'done'},appOrigin);
      } else if(event.data.type==='stop')stop();
    };
    const stop=()=>{stopped=true;clearTimeout(timeout);controller.abort();removeEventListener('message',receive);if(window[runKey]===stop)delete window[runKey];};
    window[runKey]=stop;
    addEventListener('message',receive);
  })()`;
  return `javascript:${code}`;
}

export interface FetchBundle { version: 1 | 2; weeks: { start: string; status?: number; html?: string; activityStatus?: number; activityHtml?: string; error?: string }[] }
export function isFetchBundle(value: unknown): value is FetchBundle {
  if (!value || typeof value !== 'object') return false;
  const bundle = value as FetchBundle;
  return (bundle.version === 1 || bundle.version === 2) && Array.isArray(bundle.weeks) && bundle.weeks.length <= MAX_FETCH_WEEKS && bundle.weeks.every(w => typeof w.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w.start) && (typeof w.html === 'string' || typeof w.error === 'string') && (w.activityHtml === undefined || typeof w.activityHtml === 'string'));
}
export type ParsedFetchedWeek = { start: string; person?: PersonWeek; activity?: import('./medirota').ActivityWeek; noRota?: boolean; error?: string };

/** Empty week for the default scan: HTTP 200 with no rota/people, or HTTP 404 (unpublished). 5xx is not empty. */
export function fetchedWeekIsEmpty(status: number, hasPerson: boolean): boolean {
  return !hasPerson && (status === 200 || status === 404);
}

/** Stop the default forward scan only after two parsed empty pages with weeks still queued. */
export function stopAfterTwoEmptyWeeks(weeks: ParsedFetchedWeek[], expected: number): boolean {
  return weeks.length >= 2 && expected > weeks.length && weeks.slice(-2).every(week => week.noRota === true);
}
