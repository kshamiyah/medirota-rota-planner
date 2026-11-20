import { Fragment, useState } from 'react';
import type { ISODate } from '../../engine/types';
import { fairerCellKey, fairerCodeKey, fairerVisibleDoctors, type FairerDisplay, type FairerDisplayCell } from '../fairerDisplay';

export const fairerMovedKey = 'Outlined with a dot: moved by the suggestion (tap to see what it was)';
export const fairerExtraKey = 'Dashed outline: extra shift (picked up), never moved';
const emptyCell: FairerDisplayCell = { activity: '', previous: '', code: '·', changed: false, extra: false, consultants: [] };
export function fairerCellTitle(cell: FairerDisplayCell) {
  return [cell.activity || 'No entry', ...cell.consultants, ...(cell.changed ? [`Was ${cell.previous}`] : []), ...(cell.extra ? ['Extra shift (picked up), never moved'] : [])].join(' · ');
}

export function FairerGrid({ display, dates, changedOnly, viewerId, groups, printing = false }: {
  display: FairerDisplay; dates: ISODate[]; changedOnly: boolean; viewerId?: string; groups: { id: string; name: string }[]; printing?: boolean;
}) {
  const [selected, setSelected] = useState<{ name: string; date: ISODate; cell: FairerDisplayCell }>();
  const visible = fairerVisibleDoctors(display, dates, changedOnly);
  const viewer = visible.find(person => person.id === viewerId);
  const sections = [...groups, ...(visible.some(person => !groups.some(group => group.id === person.groupId)) ? [{ id: 'fairer-no-group', name: 'Other doctors' }] : [])].map(group => ({ ...group, people: visible.filter(person => person.id !== viewerId && (group.id === 'fairer-no-group' ? !groups.some(item => item.id === person.groupId) : person.groupId === group.id)).sort((a, b) => a.name.localeCompare(b.name)) })).filter(group => group.people.length);
  const codes = fairerCodeKey(display, visible, dates, changedOnly);
  const renderPerson = (person: typeof visible[number]) => <tr key={person.id} className={person.id === viewerId ? 'fairer-me' : ''}><th scope="row" className="fairer-person">{person.name}{person.regularLocum && <span className="pill">Locum</span>}</th>{dates.map(date => {
    const cell = display.cells.get(fairerCellKey(person.id, date)) ?? emptyCell;
    const filtered = changedOnly && !cell.changed;
    const style = cell.colour !== undefined && !cell.extra ? { backgroundColor: `var(--c${cell.colour})`, color: `var(--c${cell.colour}t)` } : undefined;
    const props = { className: `fairer-cell ${cell.changed ? 'is-changed' : ''} ${cell.extra ? 'is-extra' : ''} ${filtered ? 'is-filtered' : ''}`, title: fairerCellTitle(cell), style };
    const content = <>{cell.code}{cell.changed && <i aria-hidden="true">•</i>}</>;
    return <td key={date}>{printing ? <span {...props}>{content}</span> : <button type="button" {...props} tabIndex={filtered ? -1 : 0} aria-hidden={filtered || undefined} aria-label={`${person.name}, ${date}: ${fairerCellTitle(cell)}`} onClick={() => setSelected({ name: person.name, date, cell })}>{content}</button>}</td>;
  })}</tr>;
  return <>
    {changedOnly && <p className="fairer-hidden-count" role="status">{display.doctors.length - visible.length} {display.doctors.length - visible.length === 1 ? 'doctor has' : 'doctors have'} no changes this week.</p>}
    <div className="overview-grid-wrap fairer-grid-wrap"><table className="overview-grid fairer-grid"><colgroup><col className="fairer-name-column" />{dates.map(date => <col key={date} className="fairer-day-column" />)}</colgroup><thead><tr><th className="overview-person-col">Doctor</th>{dates.map(date => <th key={date}><span>{new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })}</span><small>{new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { month: 'short' })}</small></th>)}</tr></thead><tbody>
      {viewer && renderPerson(viewer)}
      {sections.map(group => <Fragment key={group.id}><tr className="overview-group"><th colSpan={dates.length + 1}>{group.name}</th></tr>{group.people.map(renderPerson)}</Fragment>)}
      {!visible.length && <tr><td colSpan={dates.length + 1}>No changes this week.</td></tr>}
    </tbody></table></div>
    {!printing && selected && <p className="fairer-cell-detail" role="status"><strong>{selected.name}, {selected.date}:</strong> {fairerCellTitle(selected.cell)} <button type="button" onClick={() => setSelected(undefined)}>Close details</button></p>}
    <div className="overview-legend fairer-code-key" aria-label="Cell code key">{codes.map(entry => <span key={entry.code}><b style={entry.colour !== undefined ? { backgroundColor: `var(--c${entry.colour})`, color: `var(--c${entry.colour}t)` } : undefined}>{entry.code}</b> {entry.label}</span>)}</div>
    <div className="fairer-mark-key"><span>{fairerMovedKey}</span><span>{fairerExtraKey}</span></div>
  </>;
}
