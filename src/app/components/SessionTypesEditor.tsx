import { useEffect, useRef, useState } from 'react';
import { SESSION_COLOURS, type SessionTypeSetting, type SessionsSettings } from '../sessions';

export interface SessionTypePlace { id: string; name: string }

export function moveSessionPlace(settings: SessionsSettings, placeId: string, targetId?: string): SessionsSettings {
  const next = structuredClone(settings);
  for (const type of next.types) type.placeIds = type.placeIds.filter(id => id !== placeId);
  if (targetId) next.types.find(type => type.id === targetId)?.placeIds.push(placeId);
  return next;
}

export function addSessionType(settings: SessionsSettings, id: string, placeId?: string): SessionsSettings {
  const next = placeId ? moveSessionPlace(settings, placeId) : structuredClone(settings);
  const colour = SESSION_COLOURS[next.types.length % SESSION_COLOURS.length].number;
  next.types.push({ id, name: 'New session type', colour, kind: 'day', placeIds: placeId ? [placeId] : [] });
  next.ratios[id] = Object.fromEntries(next.groups.map(group => [group.id, 1]));
  return next;
}

export function SessionTypesEditor({ settings, places, unsortedPlaceIds = [], showSuggestionNote = false, onUnsortedCountChange, onChange }: {
  settings: SessionsSettings;
  places: SessionTypePlace[];
  unsortedPlaceIds?: string[];
  showSuggestionNote?: boolean;
  onUnsortedCountChange?: (count: number) => void;
  onChange: (settings: SessionsSettings) => void;
}) {
  const [resolvedUnsorted, setResolvedUnsorted] = useState<Set<string>>(() => new Set());
  const [focusType, setFocusType] = useState<string>();
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

  const change = (mutate: (next: SessionsSettings) => void) => {
    const next = structuredClone(settings);
    mutate(next);
    onChange(next);
  };
  const assignPlace = (placeId: string, targetId?: string) => {
    onChange(moveSessionPlace(settings, placeId, targetId));
    if (!targetId) setResolvedUnsorted(current => new Set(current).add(placeId));
  };
  const addType = (placeId?: string) => {
    const id = `session-custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    onChange(addSessionType(settings, id, placeId));
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
      else if (value === '__not-counted') assignPlace(place.id);
      else assignPlace(place.id, value);
    }}>
      {currentTypeId ? <option value={currentTypeId}>{settings.types.find(type => type.id === currentTypeId)?.name}</option> : isUnsorted ? <option value="__current" disabled>Not sorted yet</option> : null}
      {settings.types.filter(type => type.id !== currentTypeId).map(type => <option value={type.id} key={type.id}>{type.name}</option>)}
      <option value="__not-counted">Not counted</option>
      <option value="__new">New session type…</option>
    </select>
  </label>;
  };

  return <div className="session-types-editor">
    <p className="session-types-explanation">Session types are how Sessions and Fairer rota count work. Put each place into a type. Fairer rota only moves day sessions; on-call sessions stay where they are.</p>
    {showSuggestionNote && <p className="small muted">We've suggested types from your place names. Check them before you go on.</p>}
    {notSorted.length > 0 && <section className="session-type-card session-type-unsorted" aria-labelledby="not-sorted-title">
      <div className="session-type-card-heading"><div><h4 id="not-sorted-title">Not sorted yet</h4><p className="small muted">These places have no suggested type.</p></div></div>
      <ul className="session-type-place-list">{notSorted.map(place => <li key={place.id}><span>{place.name}</span>{moveMenu(place)}</li>)}</ul>
    </section>}
    <div className="session-type-cards">{settings.types.map(type => {
      const typePlaces = type.placeIds.map(id => byId.get(id)).filter((place): place is SessionTypePlace => !!place);
      return <article className="session-type-card" key={type.id}>
        <div className="session-type-card-fields">
          <label className="field">Name<input ref={element => { nameRefs.current[type.id] = element; }} value={type.name} onChange={event => change(next => { next.types.find(item => item.id === type.id)!.name = event.target.value; })} /></label>
          <label className="field">Colour<span className="session-colour-control"><i className={`session-swatch session-swatch-strong c${type.colour}`} aria-hidden="true" /><select aria-label={`Colour for ${type.name}`} value={type.colour} onChange={event => change(next => { next.types.find(item => item.id === type.id)!.colour = Number(event.target.value); })}>{SESSION_COLOURS.map(colour => <option key={colour.number} value={colour.number}>{colour.label}</option>)}</select></span></label>
          <label className="field">Session kind<select aria-label={`Session kind for ${type.name}`} value={type.kind} onChange={event => change(next => { next.types.find(item => item.id === type.id)!.kind = event.target.value as SessionTypeSetting['kind']; })}><option value="day">Day</option><option value="on-call">On-call</option></select></label>
          <p className="small muted session-type-kind-hint">{type.kind === 'day' ? 'Fairer rota can move these.' : 'Fairer rota leaves these alone.'}</p>
          {!typePlaces.length && <button type="button" className="link-button danger" onClick={() => change(next => { next.types = next.types.filter(item => item.id !== type.id); delete next.ratios[type.id]; })}>Remove empty type</button>}
        </div>
        {typePlaces.length ? <ul className="session-type-place-list">{typePlaces.map(place => <li key={place.id}><span>{place.name}</span>{moveMenu(place, type.id)}</li>)}</ul> : <p className="small muted">No places yet</p>}
      </article>;
    })}</div>
    <section className="session-type-card session-type-not-counted" aria-labelledby="not-counted-title">
      <div className="session-type-card-heading"><div><h4 id="not-counted-title">Not counted</h4><p className="small muted">These places don't appear in Sessions or Fairer rota.</p></div></div>
      {notCounted.length ? <ul className="session-type-place-list">{notCounted.map(place => <li key={place.id}><span>{place.name}</span>{moveMenu(place)}</li>)}</ul> : <p className="small muted">No places.</p>}
    </section>
    <button type="button" className="session-type-add" onClick={() => addType()}>+ New session type</button>
  </div>;
}
