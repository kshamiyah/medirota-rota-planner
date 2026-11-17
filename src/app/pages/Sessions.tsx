import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { dateRange } from '../../engine/calendar';
import { useWorkspace } from '../store';
import { Empty, PageHead } from '../components/ui';
import {
  analyseSessions, defaultSessionsSettings, formatSessions, offTarget, sessionDateRange, sessionEntries,
  sessionGroupOptions, gradeSessionRates, equalGradeRatios, gradeSummary, type GradeSessionRow, type SessionPersonCounts, type SessionTypeSetting,
  visibleSessionTypes, gradeDateRangeLabel, niceAxisTicks, formatAxisTick, GRADE_CHART_IMAGE_MARGIN, gradeValueLabelX,
  gradeMarkerRect, gradeTypeFocusLabel, defaultCompactSessionType, GRADE_COMPACT_CHART_WIDTH,
} from '../sessions';
import type { ISODate } from '../../engine/types';

type ChartTab = 'mix' | 'type' | 'over-time';
type ComparisonChoice = 'compare-grades' | string;
const colour = (type: SessionTypeSetting) => `var(--c${type.colour})`;
const textColour = (type: SessionTypeSetting) => `var(--c${type.colour}t)`;
const nameShort = (name: string) => name.replace(/^Dr\s+/i, '');

function groupAverage(people: SessionPersonCounts[], typeId: string) {
  const included = people.filter(person => !person.staff.locum && person.targets[typeId] !== undefined);
  if (!included.length) return { done: 0, target: 0 };
  return {
    done: included.reduce((sum, person) => sum + (person.counts[typeId] ?? 0), 0) / included.length,
    target: included.reduce((sum, person) => sum + person.targets[typeId], 0) / included.length,
  };
}

function ChartEmpty({ children }: { children: string }) {
  return <p className="small muted session-chart-empty" role="status">{children}</p>;
}

function FairnessChart({ types, people, viewingAs }: { types: SessionTypeSetting[]; people: SessionPersonCounts[]; viewingAs?: string }) {
  const doctors = people.filter(person => !person.staff.locum && types.some(type => person.targets[type.id] !== undefined));
  if (!types.length || !doctors.length) return <ChartEmpty>No doctors with targets in this group for the selected filters.</ChartEmpty>;
  const width = 900, left = 174, right = 30, plot = width - left - right, top = 20, rowHeight = 46;
  const height = top + types.length * rowHeight + 32;
  const x = (percent: number) => left + Math.min(200, Math.max(0, percent)) / 200 * plot;
  return <div className="session-chart-scroll"><svg className="session-chart fairness-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Fairness at a glance: session counts as a percentage of each target">
    <line x1={x(100)} x2={x(100)} y1="8" y2={height - 24} className="chart-target-line" />
    {[0, 50, 100, 150, 200].map(value => <g key={value}><line x1={x(value)} x2={x(value)} y1="10" y2={height - 24} className="chart-grid-line" /><text x={x(value)} y={height - 8} textAnchor="middle" className="chart-axis-label">{value}%</text></g>)}
    {types.map((type, row) => {
      const y = top + row * rowHeight + 18;
      return <g key={type.id}><text x="0" y={y + 4} className="chart-row-label">{type.name}</text><line x1={left} x2={width - right} y1={y} y2={y} className="chart-row-line" />
        {doctors.map(person => {
          const target = person.targets[type.id];
          if (target === undefined || target <= 0) return null;
          const done = person.counts[type.id] ?? 0;
          const isMe = person.staff.id === viewingAs;
          return <circle key={person.staff.id} cx={x(done / target * 100)} cy={y} r={isMe ? 6 : 3.7} fill={colour(type)} stroke={isMe ? 'var(--text)' : textColour(type)} strokeWidth={isMe ? 2 : 1} className="chart-dot"><title>{`${person.staff.name}: ${formatSessions(done)} of ${formatSessions(target)} sessions, ${Math.round(done / target * 100)}% of target`}</title></circle>;
        })}
      </g>;
    })}
  </svg><p className="small muted chart-key">Dots show doctors{viewingAs ? '; the larger outlined dot marks Viewing as' : ''}. Hover or tap a dot for the exact count.</p></div>;
}

function MixChart({ types, doctor, people }: { types: SessionTypeSetting[]; doctor?: SessionPersonCounts; people: SessionPersonCounts[] }) {
  const doctors = people.filter(person => !person.staff.locum);
  if (!types.length || (!doctor && !doctors.length)) return <ChartEmpty>No session mix to show for this group.</ChartEmpty>;
  const rows = [
    ...(doctor ? [{ label: `${doctor.staff.name} · You`, counts: types.map(type => doctor.counts[type.id] ?? 0), name: doctor.staff.name }] : []),
    { label: doctor ? 'Group average' : 'Department average', counts: types.map(type => doctors.length ? doctors.reduce((sum, person) => sum + (person.counts[type.id] ?? 0), 0) / doctors.length : 0), name: 'Group average' },
  ];
  return <div className="session-mix-chart">{rows.map(row => {
    const total = row.counts.reduce((sum, count) => sum + count, 0);
    let offset = 0;
    return <div className="mix-row" key={row.label}><div className="mix-label">{row.label}<small>{formatSessions(total)} sessions</small></div><svg viewBox="0 0 820 44" role="img" aria-label={`${row.label} session mix`}>
      <rect x="0" y="7" width="820" height="30" rx="8" className="mix-track" />
      {types.map((type, index) => {
        const count = row.counts[index]; const part = total ? count / total * 820 : 0; const start = offset; offset += part;
        return part ? <g key={type.id}><rect x={start} y="7" width={part} height="30" fill={colour(type)} stroke={textColour(type)} strokeWidth="0.8" rx="4"><title>{`${row.name}, ${type.name}: ${formatSessions(count)} sessions (${Math.round(count / total * 100)}%)`}</title></rect>{part > 60 && <text x={start + part / 2} y="27" textAnchor="middle" className="mix-segment-label">{type.name}</text>}</g> : null;
      })}
    </svg></div>;
  })}<div className="session-chart-legend">{types.map(type => <span key={type.id}><i style={{ background: colour(type), borderColor: textColour(type) }} />{type.name}</span>)}</div></div>;
}

function OneTypeChart({ type, people, viewingAs }: { type: SessionTypeSetting; people: SessionPersonCounts[]; viewingAs?: string }) {
  const doctors = people.filter(person => !person.staff.locum && person.targets[type.id] !== undefined).sort((a, b) => (b.counts[type.id] ?? 0) - (a.counts[type.id] ?? 0) || a.staff.name.localeCompare(b.staff.name));
  if (!doctors.length) return <ChartEmpty>No doctors with targets for this session type.</ChartEmpty>;
  const max = Math.max(1, ...doctors.map(person => Math.max(person.counts[type.id] ?? 0, person.targets[type.id] ?? 0)));
  const width = 900, left = 150, right = 48, plot = width - left - right, rowHeight = 35, top = 12;
  const height = Math.max(96, top + doctors.length * rowHeight + 24);
  return <div className="session-chart-scroll"><svg className="session-chart one-type-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${type.name}: sessions completed against target`}>
    {[0, 0.25, 0.5, 0.75, 1].map(fraction => <g key={fraction}><line x1={left + plot * fraction} x2={left + plot * fraction} y1="0" y2={height - 18} className="chart-grid-line" /><text x={left + plot * fraction} y={height - 3} textAnchor="middle" className="chart-axis-label">{formatSessions(max * fraction)}</text></g>)}
    {doctors.map((person, index) => {
      const y = top + index * rowHeight; const done = person.counts[type.id] ?? 0; const target = person.targets[type.id]; const isMe = person.staff.id === viewingAs;
      return <g key={person.staff.id}><text x="0" y={y + 19} className={isMe ? 'chart-doctor-label is-me' : 'chart-doctor-label'}>{nameShort(person.staff.name)}</text><rect x={left} y={y + 5} width={Math.max(2, done / max * plot)} height="18" rx="5" fill={colour(type)} stroke={textColour(type)} strokeWidth={isMe ? 2.5 : 1}><title>{`${person.staff.name}: ${formatSessions(done)} done, ${formatSessions(target)} target`}</title></rect><line x1={left + target / max * plot} x2={left + target / max * plot} y1={y + 1} y2={y + 27} className={isMe ? 'chart-target-marker is-me' : 'chart-target-marker'} /><text x={Math.min(width - right + 4, left + done / max * plot + 7)} y={y + 19} className="chart-value-label">{formatSessions(done)} / {formatSessions(target)}</text></g>;
    })}
  </svg><p className="small muted chart-key">Bars show sessions done; the vertical mark shows target. Hover or tap for the exact values.</p></div>;
}

function OverTimeChart({ profile, snapshot, settings, placements, start, end, type, doctor, groupPeople }: {
  profile: ReturnType<typeof useWorkspace>['profile']; snapshot: NonNullable<ReturnType<typeof useWorkspace>['swapFinder']>['snapshot']; settings: ReturnType<typeof defaultSessionsSettings>; placements: Record<string, string>; start: ISODate; end: ISODate; type?: SessionTypeSetting; doctor?: SessionPersonCounts; groupPeople: SessionPersonCounts[];
}) {
  const targetTypes = type ? [type] : settings.types;
  const months = [...new Set(dateRange(start, end).map(date => date.slice(0, 7)))];
  const points = months.map(month => {
    const last = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10) as ISODate;
    const through = last < end ? last : end;
    const countPerson = (staffId?: string) => staffId ? targetTypes.reduce((sum, item) => sum + sessionEntries(profile, snapshot, settings, staffId, start, through, item.id).filter(entry => !entry.extra).reduce((total, entry) => total + entry.amount, 0), 0) : 0;
    const avg = groupPeople.length ? groupPeople.reduce((sum, person) => sum + countPerson(person.staff.id), 0) / groupPeople.length : 0;
    const prefix = analyseSessions(profile, snapshot, settings, placements, start, through);
    const targetPerson = doctor ? prefix.people.find(person => person.staff.id === doctor.staff.id) : undefined;
    const target = targetPerson ? targetTypes.reduce((sum, item) => sum + (targetPerson.targets[item.id] ?? 0), 0) : 0;
    return { month, date: through, doctor: countPerson(doctor?.staff.id), avg, target };
  });
  if (!groupPeople.length) return <ChartEmpty>No target line to plot for this group.</ChartEmpty>;
  const max = Math.max(1, ...points.flatMap(point => [point.doctor, point.avg, point.target]));
  const width = 900, height = 290, left = 54, right = 20, top = 20, bottom = 42, plotW = width - left - right, plotH = height - top - bottom;
  const x = (index: number) => left + (points.length < 2 ? plotW / 2 : plotW * index / (points.length - 1));
  const y = (value: number) => top + plotH - value / max * plotH;
  const line = (key: 'doctor' | 'avg' | 'target') => points.map((point, index) => `${x(index)},${y(point[key])}`).join(' ');
  return <div className="session-chart-scroll"><svg className="session-chart over-time-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Cumulative sessions by month${type ? ` for ${type.name}` : ''}`}>
    {[0, 0.25, 0.5, 0.75, 1].map(fraction => <g key={fraction}><line x1={left} x2={width - right} y1={y(max * fraction)} y2={y(max * fraction)} className="chart-grid-line" /><text x={left - 8} y={y(max * fraction) + 4} textAnchor="end" className="chart-axis-label">{formatSessions(max * fraction)}</text></g>)}
    <polyline points={line('avg')} className="chart-line chart-line-average" />
    <polyline points={line('target')} className="chart-line chart-line-target" />
    {doctor && <polyline points={line('doctor')} className="chart-line chart-line-doctor" />}
    {points.map((point, index) => <g key={point.month}>{doctor && <circle cx={x(index)} cy={y(point.doctor)} r="5" className="chart-point-doctor"><title>{`${point.month}: ${doctor.staff.name} ${formatSessions(point.doctor)}`}</title></circle>}<circle cx={x(index)} cy={y(point.avg)} r="4" className="chart-point-average"><title>{`${point.month}: department average ${formatSessions(point.avg)}`}</title></circle><circle cx={x(index)} cy={y(point.target)} r="3" className="chart-point-target"><title>{`${point.month}: target ${formatSessions(point.target)}`}</title></circle><text x={x(index)} y={height - 14} textAnchor="middle" className="chart-axis-label">{new Date(`${point.month}-01T00:00:00Z`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</text></g>)}
  </svg><div className="session-chart-legend">{doctor && <span><i className="line-key doctor-key" />{doctor.staff.name}</span>}<span><i className="line-key average-key" />{doctor ? 'Group average' : 'Department average'}</span><span><i className="line-key target-key" />Target</span></div></div>;
}

export function gradeComparisonImageText(
  range: { start: ISODate; end: ISODate },
  groups: GradeSessionRow[],
  types: SessionTypeSetting[],
  importedAt: string,
  markerLabel: 'equal share' | 'Your ratios',
  options: { summary?: string; focusedType?: SessionTypeSetting } = {},
): string[] {
  const lines = [
    `Compare grades · ${options.focusedType?.name ?? 'Whole picture'}`,
    gradeDateRangeLabel(range.start, range.end),
  ];
  if (options.summary) lines.push(options.summary);
  lines.push(...types.map(type => type.name));
  lines.push(...groups.map(group => `${group.name}: ${group.count} doctors, ${group.fte.toFixed(1)} FTE`));
  lines.push('Sessions per full-time doctor per 4 weeks', markerLabel);
  lines.push('Sessions per full-time doctor per 4 weeks, adjusted for % time and leave. Extras and locums not included.', `Source: MediRota, imported ${importedAt}.`);
  return lines;
}

export function gradeChartImageSize(chartWidth: number, chartHeight: number, margin = GRADE_CHART_IMAGE_MARGIN) {
  return { width: chartWidth + margin * 2, height: chartHeight + margin * 2, margin };
}

function useNarrowGradeChart() {
  return useSyncExternalStore(
    onChange => {
      if (typeof window === 'undefined') return () => undefined;
      const media = window.matchMedia('(max-width: 600px)');
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    },
    () => (typeof window !== 'undefined' ? window.matchMedia('(max-width: 600px)').matches : false),
    () => false,
  );
}

function GradeChartSvg({
  svgRef, rows, types, settings, focusedType, range, importedAt, onTypeClick, width, className,
}: {
  svgRef?: { current: SVGSVGElement | null };
  rows: GradeSessionRow[];
  types: SessionTypeSetting[];
  settings: ReturnType<typeof defaultSessionsSettings>;
  focusedType?: SessionTypeSetting;
  range: { start: ISODate; end: ISODate };
  importedAt: string;
  onTypeClick?: (type: SessionTypeSetting) => void;
  width: number;
  className?: string;
}) {
  const shown = focusedType ? [focusedType] : types;
  const summary = focusedType ? gradeSummary(range.start, range.end, focusedType, rows, settings) : undefined;
  const left = Math.round(width * 0.152), right = Math.round(width * 0.033), top = focusedType ? 72 : 48, clusterGap = focusedType ? 0 : 36;
  const dataMax = Math.max(0.0001, ...shown.flatMap(type => rows.flatMap(row => [row.actual[type.id] ?? 0, row.intended[type.id] ?? 0])));
  const ticks = niceAxisTicks(dataMax);
  const max = ticks.at(-1) ?? Math.max(1, dataMax);
  const step = ticks.length > 1 ? ticks[1]! - ticks[0]! : 1;
  const barHeight = Math.min(20, focusedType ? 28 : 18);
  const rowPitch = barHeight + 4 + (focusedType ? 14 : 10);
  const clusterHeight = focusedType
    ? Math.max(150, 24 + rows.length * rowPitch)
    : Math.max(114, 28 + rows.length * rowPitch);
  const countsBlock = rows.length * 16 + 8;
  const height = top + shown.length * (clusterHeight + clusterGap) + countsBlock + 70;
  const countsTop = top + shown.length * (clusterHeight + clusterGap) + 18;
  const axisY = countsTop + countsBlock;
  const x = (value: number) => left + Math.max(0, value / max) * (width - left - right);
  const equal = shown.every(type => equalGradeRatios(type.id, settings.groups, settings));
  const markerLabel = equal ? 'equal share' : 'Your ratios';
  const cluster = (type: SessionTypeSetting, typeIndex: number) => {
    const y0 = top + typeIndex * (clusterHeight + clusterGap);
    const startY = y0 + (focusedType ? 18 : 22);
    const rowStep = rowPitch;
    return <g key={type.id}>
      {!focusedType && onTypeClick && <g className="grade-cluster-title-group" role="button" tabIndex={0} aria-label={`Show ${type.name} only`} onClick={() => onTypeClick(type)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onTypeClick(type); } }}>
        <text x="0" y={y0 + 4} className="grade-cluster-title">{gradeTypeFocusLabel(type.name)}</text>
      </g>}
      {rows.map((row, index) => {
        const y = startY + index * rowStep;
        const value = row.actual[type.id] ?? 0;
        const intended = row.intended[type.id] ?? 0;
        const barEnd = x(value);
        const markerX = x(intended);
        const valueX = gradeValueLabelX(barEnd, markerX, width - right - 8);
        const marker = gradeMarkerRect(markerX, y, barHeight);
        return <g key={row.id}>
          <text x="0" y={y + barHeight * 0.82} className="grade-bar-label">{row.name}</text>
          <rect x={left} y={y} width={Math.max(1, barEnd - left)} height={barHeight} rx="5" fill={`var(--c${type.colour})`} stroke={`var(--c${type.colour}t)`} strokeWidth="1.5"><title>{`${row.name}: ${value.toFixed(1)} ${type.name.toLocaleLowerCase('en-GB')} sessions per full-time doctor per 4 weeks`}</title></rect>
          <rect className="grade-intended-marker" x={marker.x} y={marker.y} width={marker.width} height={marker.height} fill="var(--text)"><title>{`Intended split: ${intended.toFixed(1)} per full-time doctor per 4 weeks`}</title></rect>
          <text x={valueX} y={y + barHeight * 0.8} className="grade-bar-value">{value.toFixed(1)}</text>
        </g>;
      })}
      {!focusedType && <line x1="0" x2={width - right} y1={y0 + clusterHeight} y2={y0 + clusterHeight} className="chart-grid-line" />}
    </g>;
  };
  return <svg ref={svgRef} className={className ?? 'session-chart grade-comparison-svg'} viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={`Anonymous comparison of session rates by grade${focusedType ? ` for ${focusedType.name}` : ''}`}>
    <text x="0" y="22" className="grade-chart-title">Compare grades{focusedType ? ` · ${focusedType.name}` : ' · Whole picture'}</text>
    <text x={width - right} y="22" textAnchor="end" className="chart-axis-label">{gradeDateRangeLabel(range.start, range.end)}</text>
    {summary && <text x="0" y="48" className="grade-summary-line">{summary}</text>}
    {ticks.map(tick => <g key={tick}><line x1={x(tick)} x2={x(tick)} y1={top - 12} y2={axisY - 18} className="chart-grid-line"/><text x={x(tick)} y={axisY - 4} textAnchor="middle" className="chart-axis-label">{formatAxisTick(tick, step)}</text></g>)}
    {shown.map(cluster)}
    {rows.map((row, index) => <text key={`doctor-count-${row.id}`} x="0" y={countsTop + index * 16} className="grade-doctor-count">{`${row.name}: ${row.count} doctors, ${row.fte.toFixed(1)} FTE`}</text>)}
    <g className="grade-legend"><rect x="0" y={height - 36} width="16" height="12" rx="3" fill="var(--panel-2)" stroke="var(--text)"/><text x="23" y={height - 26} className="chart-axis-label">Sessions per full-time doctor per 4 weeks</text><rect className="grade-intended-marker" x="400" y={height - 34} width="2" height="16" fill="var(--text)"/><text x="414" y={height - 26} className="chart-axis-label">{markerLabel}</text></g>
    <text x="0" y={height - 7} className="grade-footer">Sessions per full-time doctor per 4 weeks, adjusted for % time and leave. Extras and locums not included. Source: MediRota, imported {importedAt}.</text>
  </svg>;
}

function GradeComparisonChart({ rows, types, settings, focusedType, range, importedAt, onTypeClick, narrow }: {
  rows: GradeSessionRow[]; types: SessionTypeSetting[]; settings: ReturnType<typeof defaultSessionsSettings>; focusedType?: SessionTypeSetting; range: { start: ISODate; end: ISODate }; importedAt: string; onTypeClick: (type: SessionTypeSetting) => void; narrow: boolean;
}) {
  const exportRef = useRef<SVGSVGElement>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const displayWidth = narrow ? GRADE_COMPACT_CHART_WIDTH : 1080;
  const exportWidth = 1080;
  const renderPng = async () => {
    const source = exportRef.current;
    if (!source) return undefined;
    const clone = source.cloneNode(true) as SVGSVGElement;
    const rootStyles = getComputedStyle(document.documentElement);
    const tokens = ['--text','--muted','--line','--panel-2', ...Array.from({ length: 8 }, (_, i) => `--c${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `--c${i + 1}t`)];
    const declarations = tokens.map(token => `${token}:${rootStyles.getPropertyValue(token).trim()}`).join(';');
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `:root{${declarations}} text{font-family:-apple-system,BlinkMacSystemFont,sans-serif}.chart-axis-label,.grade-footer,.grade-doctor-count,.grade-summary-line{fill:#44554f}.grade-bar-value,.grade-bar-label,.grade-chart-title,.grade-cluster-title{fill:#111}.grade-chart-title{font-size:19px;font-weight:700}.grade-bar-label{font-weight:600;font-size:13px}.grade-bar-value{font-size:12px;font-weight:700}.grade-footer,.grade-doctor-count,.grade-summary-line{font-size:11px}.chart-grid-line{stroke:#d5ddd9;stroke-width:1}.grade-cluster-title{font-size:14px;font-weight:700}.grade-intended-marker{fill:#111}`;
    clone.insertBefore(style, clone.firstChild);
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const serialized = new XMLSerializer().serializeToString(clone);
    const image = new Image();
    image.src = URL.createObjectURL(new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' }));
    await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error('Could not render chart image')); });
    const height = Number(clone.getAttribute('height') ?? exportWidth);
    const margin = GRADE_CHART_IMAGE_MARGIN;
    const size = gradeChartImageSize(exportWidth, height, margin);
    const canvas = document.createElement('canvas'); canvas.width = size.width * 2; canvas.height = size.height * 2;
    const context = canvas.getContext('2d');
    if (!context) return undefined;
    context.scale(2, 2);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(image, margin, margin, exportWidth, height);
    URL.revokeObjectURL(image.src);
    return await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png')) ?? undefined;
  };
  const fileStem = `compare-grades-${focusedType?.name.toLocaleLowerCase('en-GB').replace(/[^a-z0-9]+/g, '-') ?? 'all-types'}`;
  const downloadChart = async () => {
    const blob = await renderPng();
    if (!blob) return;
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${fileStem}.png`; link.click(); URL.revokeObjectURL(link.href);
    setCopyStatus('Image downloaded.');
  };
  const copyChart = async () => {
    const blob = await renderPng();
    if (!blob) return;
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') throw new Error('Clipboard image unavailable');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setCopyStatus('Chart copied as an image.');
    } catch {
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${fileStem}.png`; link.click(); URL.revokeObjectURL(link.href);
      setCopyStatus('Clipboard image unavailable. Image downloaded.');
    }
  };
  return <div className={`grade-chart-export-wrap${narrow ? ' is-narrow' : ''}`}>
    <GradeChartSvg className="session-chart grade-comparison-svg" rows={rows} types={types} settings={settings} focusedType={focusedType} range={range} importedAt={importedAt} onTypeClick={onTypeClick} width={displayWidth} />
    <div className="grade-chart-export-source" aria-hidden="true">
      <GradeChartSvg svgRef={exportRef} rows={rows} types={types} settings={settings} focusedType={focusedType} range={range} importedAt={importedAt} width={exportWidth} />
    </div>
    <div className="grade-chart-actions"><button type="button" className="primary" onClick={() => void copyChart()}>Copy chart</button><button type="button" onClick={() => void downloadChart()}>Download image</button></div>{copyStatus && <p role="status" className="small muted">{copyStatus}</p>}
  </div>;
}

export function Sessions({ go }: { go: (page: 'import') => void }) {
  const ws = useWorkspace();
  const snapshot = ws.swapFinder?.snapshot;
  const defaults = useMemo(() => defaultSessionsSettings(ws.profile), [ws.profile]);
  const settings = ws.sessions ?? defaults;
  const range = sessionDateRange(snapshot);
  const narrowGradeChart = useNarrowGradeChart();
  const [start, setStart] = useState<ISODate>(range?.start ?? ws.period.start);
  const [end, setEnd] = useState<ISODate>(range?.end ?? ws.period.end);
  const [groupId, setGroupId] = useState<ComparisonChoice>('compare-grades');
  const [hideOnCalls, setHideOnCalls] = useState(false);
  const [tab, setTab] = useState<ChartTab>('mix');
  const [typeId, setTypeId] = useState(settings.types[0]?.id ?? '');
  const [overTimeTypeId, setOverTimeTypeId] = useState('all');
  const [detail, setDetail] = useState<{ staffId: string; typeId: string | 'extras' }>();
  useEffect(() => { if (range) { setStart(range.start); setEnd(range.end); } }, [range?.start, range?.end]);
  const analysis = useMemo(() => snapshot && start <= end ? analyseSessions(ws.profile, snapshot, settings, ws.sessionSubGroups ?? {}, start, end) : undefined,
    [snapshot, ws.profile, settings, ws.sessionSubGroups, start, end]);
  const options = sessionGroupOptions(settings);
  const me = ws.role === 'coordinator' ? undefined : analysis?.people.find(person => person.staff.id === ws.me);
  useEffect(() => { if (groupId === 'compare-grades') return; if (!options.some(option => option.id === groupId) && options.length) setGroupId(me?.comparisonId ?? me?.groupId ?? options[0].id); }, [groupId, options.length, me?.comparisonId, me?.groupId]);
  const selectedOption = options.find(option => option.id === groupId) ?? options[0];
  const shownTypes = visibleSessionTypes(settings.types, hideOnCalls);
  useEffect(() => { if (overTimeTypeId !== 'all' && !shownTypes.some(type => type.id === overTimeTypeId)) setOverTimeTypeId('all'); }, [overTimeTypeId, shownTypes.map(type => type.id).join('|')]);
  const selectedType = shownTypes.find(type => type.id === typeId) ?? shownTypes[0];
  useEffect(() => { if (selectedType && typeId !== selectedType.id) setTypeId(selectedType.id); }, [typeId, selectedType?.id]);
  if (!snapshot || !range) return <><PageHead title="Sessions">Compare session counts within grade groups.</PageHead><Empty><h2>Import a rota first</h2><p>Sessions will show counts after you import a MediRota rota.</p><button className="primary" onClick={() => go('import')}>Update from MediRota</button></Empty></>;
  const comparingGrades = groupId === 'compare-grades';
  const selectedComparison = options.find(option => option.id === groupId) ?? options[0];
  const gradeRows = analysis ? gradeSessionRates(analysis, settings) : [];
  const gradeTypes = shownTypes;
  const compactDefaultType = defaultCompactSessionType(gradeTypes);
  useEffect(() => {
    if (!comparingGrades || !narrowGradeChart || !compactDefaultType) return;
    if (overTimeTypeId === 'all' || !gradeTypes.some(type => type.id === overTimeTypeId)) setOverTimeTypeId(compactDefaultType.id);
  }, [comparingGrades, narrowGradeChart, compactDefaultType?.id, overTimeTypeId, gradeTypes.map(type => type.id).join('|')]);
  const focusedGradeType = overTimeTypeId === 'all' ? undefined : gradeTypes.find(type => type.id === overTimeTypeId);
  const importValue = Object.values(snapshot.importedAt).sort().at(-1);
  const importedAt = importValue ? new Date(importValue).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'unknown date';
  const groupPeople = (analysis?.people ?? []).filter(person => selectedComparison && person.comparisonId === selectedComparison.id);
  const targetPeople = groupPeople.filter(person => !person.staff.locum && shownTypes.some(type => person.targets[type.id] !== undefined));
  const details = detail && analysis ? sessionEntries(ws.profile, snapshot, settings, detail.staffId, start, end, detail.typeId === 'extras' ? undefined : detail.typeId).filter(entry => detail.typeId === 'extras' ? entry.extra : !entry.extra) : [];
  const dateChange = (which: 'start' | 'end', value: ISODate) => {
    if (which === 'start') { setStart(value); if (value > end) setEnd(value); }
    else { setEnd(value); if (value < start) setStart(value); }
  };
  const avgDone = (type: SessionTypeSetting) => groupAverage(groupPeople, type.id).done;
  const avgTarget = (type: SessionTypeSetting) => groupAverage(groupPeople, type.id).target;
  return <div className="sessions-page">
    <PageHead title="Sessions">See how session work is shared within a comparison group.</PageHead>
    <section className="sessions-controls">
      <label className="field">From<input type="date" min={range.start} max={range.end} value={start} onChange={event => dateChange('start', event.target.value as ISODate)} /></label>
      <label className="field">To<input type="date" min={range.start} max={range.end} value={end} onChange={event => dateChange('end', event.target.value as ISODate)} /></label>
      <label className="field">Comparison group<select value={groupId} onChange={event => setGroupId(event.target.value)}><option value="compare-grades">Compare grades</option>{options.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></label>
      <label className="sessions-toggle"><input type="checkbox" checked={hideOnCalls} onChange={event => setHideOnCalls(event.target.checked)} />Hide on-calls</label>
    </section>
    {comparingGrades ? <section className="grade-comparison-section">
      <div className="grade-comparison-controls"><div><p className="eyebrow">Across comparison groups</p><h2>Compare grades</h2><p className="small muted">Sessions per full-time doctor per 4 weeks, adjusted for % time and leave.</p></div><label className="field">Session type<select value={overTimeTypeId} onChange={event => setOverTimeTypeId(event.target.value)} aria-label="Session type">{!narrowGradeChart && <option value="all">All types</option>}{gradeTypes.map(type => <option key={type.id} value={type.id}>{type.name}</option>)}</select></label></div>
      {analysis && <GradeComparisonChart rows={gradeRows} types={gradeTypes} settings={settings} focusedType={focusedGradeType} range={{ start, end }} importedAt={importedAt} onTypeClick={type => setOverTimeTypeId(type.id)} narrow={narrowGradeChart} />}
      <div className="grade-table-wrap"><table className="grade-comparison-table"><thead><tr><th>Group</th>{gradeTypes.map(type => <th key={type.id} onClick={() => setOverTimeTypeId(type.id)}>{type.name}</th>)}<th>Doctors</th></tr></thead><tbody>
        {gradeRows.map(row => <tr key={row.id}><th>{row.name}</th>{gradeTypes.map(type => <td key={type.id}>{row.actual[type.id].toFixed(1)}</td>)}<td>{row.count} ({row.fte.toFixed(1)} FTE)</td></tr>)}
        <tr className="grade-total-row"><th>Total sessions</th>{gradeTypes.map(type => <td key={type.id}>{gradeRows.reduce((sum, row) => sum + row.totals[type.id], 0).toFixed(1)}</td>)}<td>—</td></tr>
      </tbody></table></div>
    </section> : <>
    <section className="sessions-chart-panel">
      <div className="sessions-chart-heading"><div><p className="eyebrow">{selectedOption?.name ?? 'Comparison group'}</p><h2>Fairness at a glance</h2><p className="small muted">Session counts as a percentage of target. The vertical line marks 100%.</p></div></div>
      {analysis && <FairnessChart types={shownTypes} people={targetPeople} viewingAs={ws.role === 'coordinator' ? undefined : ws.me} />}
      <div className="sessions-chart-tabs" role="tablist" aria-label="Session charts">{([['mix', 'My mix'], ['type', 'One type'], ['over-time', 'Over time']] as const).map(([id, label]) => <button type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} key={id} onClick={() => setTab(id)}>{label}</button>)}</div>
      {tab === 'mix' && <div role="tabpanel"><h3>{ws.role === 'coordinator' ? 'Department mix' : 'My mix'}</h3><p className="small muted">Counted sessions shown as a share of each total.</p><MixChart types={shownTypes} doctor={me} people={targetPeople} /></div>}
      {tab === 'type' && selectedType && <div role="tabpanel"><div className="sessions-chart-subhead"><div><h3>One type</h3><p className="small muted">Sorted by sessions completed; marks show each target.</p></div><label className="field">Session type<select value={selectedType.id} onChange={event => setTypeId(event.target.value)}>{shownTypes.map(type => <option value={type.id} key={type.id}>{type.name}</option>)}</select></label></div><OneTypeChart type={selectedType} people={targetPeople} viewingAs={ws.role === 'coordinator' ? undefined : ws.me} /></div>}
      {tab === 'over-time' && <div role="tabpanel"><div className="sessions-chart-subhead"><div><h3>Over time</h3><p className="small muted">Cumulative sessions by month.</p></div><label className="field">Session type<select value={overTimeTypeId} onChange={event => setOverTimeTypeId(event.target.value)}><option value="all">All session types</option>{shownTypes.map(type => <option value={type.id} key={type.id}>{type.name}</option>)}</select></label></div><OverTimeChart profile={ws.profile} snapshot={snapshot} settings={settings} placements={ws.sessionSubGroups ?? {}} start={start} end={end} type={overTimeTypeId === 'all' ? undefined : settings.types.find(type => type.id === overTimeTypeId)} doctor={me && !me.staff.locum && shownTypes.some(type => me.targets[type.id] !== undefined) ? me : undefined} groupPeople={targetPeople} /></div>}
    </section>

    <section className="sessions-table-section"><div className="sessions-table-title"><div><p className="eyebrow">{selectedOption?.name ?? 'Comparison group'}</p><h2>Session counts</h2></div><p className="small muted">Done / target</p></div>
      {!groupPeople.length ? <ChartEmpty>No doctors in this comparison group.</ChartEmpty> : <div className="table-wrap"><table className="sessions-table"><thead><tr><th>Doctor</th>{shownTypes.map(type => <th key={type.id}><span className="session-colour-key" style={{ background: colour(type), borderColor: textColour(type) }} />{type.name}</th>)}<th>Extras</th></tr></thead><tbody>
        {groupPeople.map(person => <SessionDoctorRows key={person.staff.id} person={person} types={shownTypes} me={ws.me} selected={detail} onCell={typeId => setDetail(detail?.staffId === person.staff.id && detail.typeId === typeId ? undefined : { staffId: person.staff.id, typeId })} onExtras={() => setDetail(detail?.staffId === person.staff.id && detail.typeId === 'extras' ? undefined : { staffId: person.staff.id, typeId: 'extras' })} entries={details} />)}
        {groupPeople.some(person => !person.staff.locum && shownTypes.some(type => person.targets[type.id] !== undefined)) && <tr className="sessions-average-row"><th>Group average</th>{shownTypes.map(type => <td key={type.id}>{formatSessions(avgDone(type))} / {formatSessions(avgTarget(type))}</td>)}<td>—</td></tr>}
      </tbody></table></div>}
    </section>
    {analysis?.unmapped.length ? <p className="small muted session-page-note">Not counted yet: {analysis.unmapped.map(item => `${item.activity} (${item.count})`).join(', ')}.</p> : null}
    {analysis?.ignored.length ? <p className="small muted session-page-note">Not counted: {analysis.ignored.map(item => `${item.activity} (${item.count})`).join(', ')}.</p> : null}
    <details className="session-targets-note"><summary>How targets are worked out</summary><p>Availability = days in post in the selected range × % time, minus leave days. For each session type, non-extra sessions completed by non-locum doctors in the configured comparison groups are shared by each doctor’s group ratio × availability. Regular locums are listed with their counts but do not add sessions to the target pool.</p></details>
    </>}
  </div>;
}

function SessionDoctorRows({ person, types, me, selected, onCell, onExtras, entries }: {
  person: SessionPersonCounts; types: SessionTypeSetting[]; me?: string; selected?: { staffId: string; typeId: string | 'extras' }; onCell: (typeId: string) => void; onExtras: () => void; entries: ReturnType<typeof sessionEntries>;
}) {
  const expanded = selected?.staffId === person.staff.id;
  return <>
    <tr className={`session-doctor-row${person.staff.id === me ? ' is-me' : ''}`}><th>{person.staff.name}{person.staff.locum && <span className="pill session-locum-pill">Locum</span>}</th>
      {types.map(type => <td key={type.id}>{<button type="button" className={`session-count-cell${offTarget(person.counts[type.id] ?? 0, person.targets[type.id] ?? 0) ? ` is-${offTarget(person.counts[type.id] ?? 0, person.targets[type.id] ?? 0)}` : ''}`} onClick={() => onCell(type.id)}>{formatSessions(person.counts[type.id] ?? 0)} / {person.staff.locum || person.targets[type.id] === undefined ? '—' : formatSessions(person.targets[type.id])}</button>}</td>)}
      <td><button type="button" className="session-extra-count" onClick={onExtras} title="Show extra shift dates">{person.extras ? formatSessions(person.extras) : '—'}</button></td>
    </tr>
    {expanded && <tr className="session-detail-row"><td colSpan={types.length + 2}><div className="session-date-detail-inline"><b>{selected?.typeId === 'extras' ? 'Extra shifts' : types.find(type => type.id === selected?.typeId)?.name}</b>{entries.length ? <ul>{entries.map(entry => <li key={`${entry.date}-${entry.activity}`}>{entry.date} · {entry.activity} · {formatSessions(entry.amount)} {entry.extra ? 'extra' : 'session'}</li>)}</ul> : <span className="small muted">No dates in this range.</span>}</div></td></tr>}
  </>;
}
