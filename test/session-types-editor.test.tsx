import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionTypesEditor, addSessionType, moveSessionPlace } from '../src/app/components/SessionTypesEditor';
import { defaultSessionsSettings } from '../src/app/sessions';
import { emptyProfile, emptyWorkspace } from '../src/app/store';
import { suggestSessionType, wizardSettingsDraft } from '../src/app/pages/SetupWizard';

function draftFixture() {
  const profile = emptyProfile();
  profile.roles = [
    { id: 'ward', name: 'Maple Ward' },
    { id: 'theatre', name: 'Cedar Theatre' },
    { id: 'clinic', name: 'Willow Clinic' },
    { id: 'quiet', name: 'Garden Room' },
  ];
  profile.groups = [{ id: 'junior', name: 'Junior doctors' }];
  const workspace = emptyWorkspace();
  workspace.profile = profile;
  const settings = wizardSettingsDraft(workspace);
  if (settings.types[0]) settings.types[0].kind = 'on-call';
  const places = profile.roles.map(({ id, name }) => ({ id, name }));
  const unsortedPlaceIds = places.filter(place => suggestSessionType(place.name) === 'Not counted').map(place => place.id);
  return { profile, settings, places, unsortedPlaceIds };
}

describe('shared session types editor', () => {
  it('renders suggested types and first-time unsorted places before the cards', () => {
    const { settings, places, unsortedPlaceIds } = draftFixture();
    const html = renderToStaticMarkup(createElement(SessionTypesEditor, { settings, places, unsortedPlaceIds, showSuggestionNote: true, onChange() {} }));
    expect(html.indexOf('Not sorted yet')).toBeLessThan(html.indexOf('Maple Ward'));
    expect(html).toContain('Willow Clinic');
    expect(html).toContain('Garden Room');
    expect(html).toContain('Session types are how Sessions and Fairer rota count work.');
    expect(html).toContain('suggested types from your place names. Check them before you go on.');
  });

  it('moves a place between types or to Not counted without changing its kind', () => {
    const { settings } = draftFixture();
    const wardType = settings.types.find(type => type.name === 'Wards')!;
    const theatreType = settings.types.find(type => type.name === 'Theatre')!;
    let next = moveSessionPlace(settings, 'ward', theatreType.id);
    expect(next.types.find(type => type.id === wardType.id)?.placeIds).not.toContain('ward');
    expect(next.types.find(type => type.id === theatreType.id)?.placeIds).toContain('ward');
    expect(next.types.find(type => type.id === theatreType.id)?.kind).toBe(theatreType.kind);
    next = moveSessionPlace(next, 'ward');
    expect(next.types.every(type => !type.placeIds.includes('ward'))).toBe(true);
    expect(settings.types.find(type => type.id === wardType.id)?.placeIds).toContain('ward');
  });

  it('creates a real type inline and offers no phantom type names', () => {
    const { settings, places, unsortedPlaceIds } = draftFixture();
    const next = addSessionType(settings, 'custom', 'quiet');
    expect(next.types.find(type => type.id === 'custom')).toMatchObject({ name: 'New session type', kind: 'day', placeIds: ['quiet'] });
    const html = renderToStaticMarkup(createElement(SessionTypesEditor, { settings, places, unsortedPlaceIds, onChange() {} }));
    expect(html).toContain('New session type…');
    expect(html).not.toContain('<option value="Assessment">');
    expect(html).not.toContain('Suggested');
    expect(html.match(/<option value="__not-counted">Not counted<\/option>/g)).toHaveLength(4);
  });

  it('sets Day or On-call on the card, once for all its places', () => {
    const { settings, places } = draftFixture();
    const html = renderToStaticMarkup(createElement(SessionTypesEditor, { settings, places, onChange() {} }));
    for (const type of settings.types) expect(html.match(new RegExp(`aria-label="Session kind for ${type.name}"`, 'g'))).toHaveLength(1);
    expect(html).toContain('Fairer rota can move these.');
    expect(html).toContain('Fairer rota leaves these alone.');
    expect(html.match(/New session type…/g)).toHaveLength(4);
  });

  it('keeps an empty saved settings object neutral', () => {
    const empty = defaultSessionsSettings(emptyProfile());
    expect(empty.types).toEqual([]);
  });

  it('shows a clear Not counted line and strong colour swatches', () => {
    const { settings, places } = draftFixture();
    const html = renderToStaticMarkup(createElement(SessionTypesEditor, { settings, places, onChange() {} }));
    expect(html).toContain('>Not counted<');
    expect(html).toMatch(/These places don(?:'|&#x27;)t appear in Sessions or Fairer rota\./);
    expect(html).not.toMatch(/Not counted: these places don/);
    expect(html).toContain('session-swatch session-swatch-strong');
  });
});
