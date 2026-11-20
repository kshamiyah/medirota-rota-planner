import { useEffect, useRef, useState } from 'react';
import { SESSION_COLOURS, type SessionTypeSetting, type SessionsSettings } from '../sessions';
import type { BookedShiftWarning } from '../bookedShiftWarnings';

export interface SessionTypePlace { id: string; name: string; originalName?: string }

export function moveSessionPlace(settings: SessionsSettings, placeId: string, targetId?: string): SessionsSettings {
  const next = structuredClone(settings);
  for (const type of next.types) type.placeIds = type.placeIds.filter(id => id !== placeId);
  if (targetId) next.types.find(type => type.id === targetId)?.placeIds.push(placeId);
  return next;
}

export function firstUnusedSessionColour(settings: SessionsSettings): number {
  const used = new Set(settings.types.map(type => type.colour));
  return SESSION_COLOURS.find(colour => !used.has(colour.number))?.number ?? SESSION_COLOURS[settings.types.length % SESSION_COLOURS.length].number;
}

export function addSessionType(settings: SessionsSettings, id: string, placeId?: string, placeName?: string): SessionsSettings {
  const next = placeId ? moveSessionPlace(settings, placeId) : structuredClone(settings);
  const colour = firstUnusedSessionColour(next);
  next.types.push({ id, name: placeId ? (placeName ?? 'New session type') : 'New session type', colour, kind: 'day', placeIds: placeId ? [placeId] : [] });
  next.ratios[id] = Object.fromEntries(next.groups.map(group => [group.id, 1]));
  return next;
}

export function SessionTypesEditor({ settings, places, unsortedPlaceIds = [], bookedWarnings = [], initialUnselectedKindIds = [], showSuggestionNote = false, kindRequired = false, onUnsortedCountChange, onKindsReadyChange, onUnselectedKindChange, onRenamePlace, onChange }: {
  settings: SessionsSettings;
  places: SessionTypePlace[];
  unsortedPlaceIds?: string[];
  bookedWarnings?: BookedShiftWarning[];
  initialUnselectedKindIds?: string[];
  showSuggestionNote?: boolean;
  kindRequired?: boolean;
  onUnsortedCountChange?: (count: number) => void;
  onKindsReadyChange?: (ready: boolean) => void;
  onUnselectedKindChange?: (typeId: string, unselected: boolean) => void;
  onRenamePlace?: (id: string, name: string) => void;
  onChange: (settings: SessionsSettings) => void;
}) {
  const [resolvedUnsorted, setResolvedUnsorted] = useState<Set<string>>(() => new Set());
  const [unselectedKinds, setUnselectedKinds] = useState<Set<string>>(() => new Set(initialUnselectedKindIds));
  const [focusType, setFocusType] = useState<string>();
  const [dismissedWarnings, setDismissedWarnings] = useState<Set<string>>(() => new Set());
  const nameRefs = useRef<Record<string, HTMLInputElement | null>>({});
  useEffect(() => {
    if (!focusType) return;
    nameRefs.current[focusType]?.focus();
    nameRefs.current[focusType]?.select();
    setFocusType(undefined);
  }, [focusType, settings.types.length]);

  const byId = new Map(places.map(place => [place.id, place]));
  const membership = new Set(settings.types.flatMap(type => type.placeIds));
  const notSorted = places.filter(place => unsortedPlaceIds.includes(place.id) && !membership.has(place.id) && !resolvedUnsorted.has(place.id));
  const notCounted = places.filter(place => !membership.has(place.id) && !notSorted.some(item => item.id === place.id));
  useEffect(() => { onUnsortedCountChange?.(notSorted.length); }, [notSorted.length, onUnsortedCountChange]);
  useEffect(() => {
    if (!kindRequired) { onKindsReadyChange?.(true); return; }
    const ready = settings.types.every(type => !type.placeIds.length || !unselectedKinds.has(type.id));
    onKindsReadyChange?.(ready);
  }, [kindRequired, settings.types, unselectedKinds, onKindsReadyChange]);

  const change = (mutate: (next: SessionsSettings) => void) => {
    const next = structuredClone(settings);
    mutate(next);
    onChange(next);
  };
  const assignPlace = (placeId: string, targetId?: string) => {
    onChange(moveSessionPlace(settings, placeId, targetId));
    if (!targetId) setResolvedUnsorted(current => new Set(current).add(placeId));
  };
  const addType = (placeId?: string, own = false) => {
    const id = `session-custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const place = placeId ? byId.get(placeId) : undefined;
    onChange(addSessionType(settings, id, placeId, own ? place?.name : undefined));
    if (kindRequired) { setUnselectedKinds(current => new Set(current).add(id)); onUnselectedKindChange?.(id, true); }
    if (placeId) setResolvedUnsorted(current => new Set(current).add(placeId));
    setFocusType(id);
  };
  const moveMenu = (place: SessionTypePlace, currentTypeId?: string) => {
    const isUnsorted = notSorted.some(item => item.id === place.id);
    return <label className="session-place-move">
    <span className="visually-hidden">Session type for {place.name}</span>
    <select aria-label={`Session type for ${place.name}`} value={currentTypeId ?? (isUnsorted ? '__current' : '__not-counted')} onChange={event => {
      const value = event.target.value;
      if (value === '__new') addType(place.id);
      else if (value === '__own') addType(place.id, true);
      else if (value === '__not-counted') assignPlace(place.id);
      else assignPlace(place.id, value);
    }}>
      {currentTypeId ? <option value={currentTypeId}>{settings.types.find(type => type.id === currentTypeId)?.name}</option> : isUnsorted ? <option value="__current" disabled>Not sorted yet</option> : null}
      {settings.types.filter(type => type.id !== currentTypeId).map(type => <option value={type.id} key={type.id}>{type.name}</option>)}
      <option value="__not-counted">Not counted</option>
      <option value="__own">Make this its own type</option>
      <option value="__new">New session type…</option>
    </select>
  </label>;
  };

  return <div className="session-types-editor">
    <p className="session-types-explanation">Session types are how Sessions and Fairer rota count work. Put each place into a type. Fairer rota only moves day sessions; on-call sessions stay where they are.</p>
    <p className="small muted">Booked nights and long days usually go in On-call types, so Fairer rota leaves them where they are. Day jobs go in Day types, which Fairer rota can move.</p>
    {showSuggestionNote && <p className="small muted">We've suggested types from your place names. Check them before you go on.</p>}
    {notSorted.length > 0 && <section className="session-type-card session-type-unsorted" aria-labelledby="not-sorted-title">
      <div className="session-type-card-heading"><div><h4 id="not-sorted-title">Not sorted yet</h4><p className="small muted">Choose a type for each place, or leave it Not counted.</p></div></div>
      <ul className="session-type-place-list">{notSorted.map(place => <li key={place.id}><PlaceLabel place={place} onRename={onRenamePlace} />{moveMenu(place)}</li>)}</ul>
    </section>}
    <div className="session-type-cards">{settings.types.map(type => {
      const typePlaces = type.placeIds.map(id => byId.get(id)).filter((place): place is SessionTypePlace => !!place);
      const kindUnset = kindRequired && unselectedKinds.has(type.id);
      const kind = kindUnset ? undefined : type.kind;
      return <article className="session-type-card" key={type.id}>
        <div className="session-type-card-fields">
          <label className="field">Name<input ref={element => { nameRefs.current[type.id] = element; }} value={type.name} onChange={event => change(next => { next.types.find(item => item.id === type.id)!.name = event.target.value; })} /></label>
          <label className="field">Colour<span className="session-colour-control"><i className={`session-swatch session-swatch-strong c${type.colour}`} aria-hidden="true" /><select aria-label={`Colour for ${type.name}`} value={type.colour} onChange={event => change(next => { next.types.find(item => item.id === type.id)!.colour = Number(event.target.value); })}>{SESSION_COLOURS.map(colour => <option key={colour.number} value={colour.number} disabled={nextColourUsed(settings, type.id, colour.number)}>{colour.label}{nextColourUsed(settings, type.id, colour.number) ? ` (used by ${settings.types.find(item => item.colour === colour.number)?.name})` : ''}</option>)}</select></span></label>
          <label className="field">Session kind<select aria-label={`Session kind for ${type.name || 'new session type'}`} value={kind ?? ''} onChange={event => { setUnselectedKinds(current => { const next = new Set(current); next.delete(type.id); return next; }); onUnselectedKindChange?.(type.id, false); change(next => { next.types.find(item => item.id === type.id)!.kind = event.target.value as SessionTypeSetting['kind']; }); }}><option value="" disabled>Choose Day or On-call</option><option value="day">Day</option><option value="on-call">On-call</option></select></label>
          {kind === 'day' && <p className="small muted session-type-kind-hint">Fairer rota can move these.</p>}
          {kind === 'on-call' && <p className="small muted session-type-kind-hint">Fairer rota leaves these alone.</p>}
          {!typePlaces.length && <button type="button" className="link-button danger" onClick={() => { change(next => { next.types = next.types.filter(item => item.id !== type.id); delete next.ratios[type.id]; }); onUnselectedKindChange?.(type.id, false); }}>Remove empty type</button>}
        </div>
        {typePlaces.length ? <ul className="session-type-place-list">{typePlaces.map(place => <li key={place.id}><PlaceLabel place={place} onRename={onRenamePlace} />{moveMenu(place, type.id)}</li>)}</ul> : <p className="small muted">No places yet</p>}
        {kind === 'day' && bookedWarnings.filter(warning => type.placeIds.includes(warning.placeId) && !dismissedWarnings.has(warning.placeId)).map(warning => <aside className="notice warn booked-shift-warning" key={`${warning.placeId}|${warning.kind}`}><p>⚠ {warning.activity} is a {warning.kind} in MediRota, but its type "{type.name}" is set to Day, so Fairer rota could move it.</p><div className="row"><button type="button" onClick={() => { change(next => { next.types.find(item => item.id === type.id)!.kind = 'on-call'; }); setUnselectedKinds(current => { const next = new Set(current); next.delete(type.id); return next; }); onUnselectedKindChange?.(type.id, false); }}>Set "{type.name}" to On-call</button><button type="button" onClick={() => setDismissedWarnings(current => new Set(current).add(warning.placeId))}>Keep as Day</button></div></aside>)}
      </article>;
    })}</div>
    <section className="session-type-card session-type-not-counted" aria-labelledby="not-counted-title">
      <div className="session-type-card-heading"><div><h4 id="not-counted-title">Not counted</h4><p className="small muted">These places don't appear in Sessions or Fairer rota.</p></div></div>
      {notCounted.length ? <ul className="session-type-place-list">{notCounted.map(place => <li key={place.id}><PlaceLabel place={place} onRename={onRenamePlace} />{moveMenu(place)}</li>)}</ul> : <p className="small muted">No places.</p>}
    </section>
    <button type="button" className="session-type-add" onClick={() => addType()}>+ New session type</button>
    <p className="small muted session-type-unsorted-count" aria-live="polite">{notSorted.length ? `${notSorted.length} ${notSorted.length === 1 ? 'place' : 'places'} not sorted yet` : 'All places sorted ✓'}</p>
  </div>;
}

function nextColourUsed(settings: SessionsSettings, currentTypeId: string, colour: number): boolean {
  return settings.types.some(type => type.id !== currentTypeId && type.colour === colour);
}

function PlaceLabel({ place, onRename }: { place: SessionTypePlace; onRename?: (id: string, name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(place.name);
  useEffect(() => setValue(place.name), [place.name]);
  const commit = () => { const name = value.trim(); if (name && name !== place.name) onRename?.(place.id, name); setEditing(false); };
  return <span className="session-place-label">{editing ? <input aria-label={`Rename ${place.name}`} value={value} onChange={event => setValue(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') commit(); if (event.key === 'Escape') { setValue(place.name); setEditing(false); } }} autoFocus /> : <>{place.name}{onRename && <button type="button" className="link-button" aria-label={`Rename ${place.name}`} onClick={() => setEditing(true)}>✎</button>}</>}{place.originalName && place.originalName !== place.name && <small className="small muted">MediRota: {place.originalName}</small>}</span>;
}
