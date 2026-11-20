import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SessionTypesEditor, addSessionType, firstUnusedSessionColour, moveSessionPlace } from '../src/app/components/SessionTypesEditor';
import { SESSION_COLOURS, defaultSessionsSettings } from '../src/app/sessions';
import { emptyProfile, emptyWorkspace } from '../src/app/store';
import { wizardSettingsDraft } from '../src/app/pages/SetupWizard';

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
  const places = profile.roles.map(({ id, name }) => ({ id, name }));
  const unsortedPlaceIds = places.map(place => place.id);
  return { profile, settings, places, unsortedPlaceIds };
}

describe('shared session types editor', () => {
  it('renders every first-time place as unsorted without suggesting types', () => {
    const { settings, places, unsortedPlaceIds } = draftFixture();
    const html = renderToStaticMarkup(createElement(SessionTypesEditor, { settings, places, unsortedPlaceIds, onChange() {} }));
    expect(html.indexOf('Not sorted yet')).toBeLessThan(html.indexOf('Maple Ward'));
    expect(html).toContain('Willow Clinic');
    expect(html).toContain('Garden Room');
    expect(html).toContain('Session types are how Sessions and Fairer rota count work.');
    expect(html).not.toContain('suggested types from your place names');
  });

  it('moves a place between types or to Not counted without changing its kind', () => {
    const { settings } = draftFixture();
    let next = addSessionType(settings, 'theatre-type', 'theatre');
    next = addSessionType(next, 'ward-type', 'ward');
    const wardKind = next.types.find(type => type.id === 'ward-type')?.kind;
    next = moveSessionPlace(next, 'ward', 'theatre-type');
    expect(next.types.find(type => type.id === 'ward-type')?.placeIds).not.toContain('ward');
    expect(next.types.find(type => type.id === 'theatre-type')?.placeIds).toContain('ward');
    expect(next.types.find(type => type.id === 'ward-type')?.kind).toBe(wardKind);
    next = moveSessionPlace(next, 'ward');
    expect(next.types.every(type => !type.placeIds.includes('ward'))).toBe(true);
    expect(settings.types).toEqual([]);
  });

  it('creates a real type inline and offers no phantom type names', () => {
    const { settings, places, unsortedPlaceIds } = draftFixture();
    const next = addSessionType(settings, 'custom', 'quiet', 'Garden Room');
    expect(next.types.find(type => type.id === 'custom')).toMatchObject({ name: 'Garden Room', kind: 'day', placeIds: ['quiet'] });
    expect(addSessionType(settings, 'plain').types[0]).toMatchObject({ name: 'New session type', kind: 'day' });
    const html = renderToStaticMarkup(createElement(SessionTypesEditor, { settings, places, unsortedPlaceIds, onChange() {} }));
    expect(html).toContain('New session type…');
    expect(html).not.toContain('<option value="Assessment">');
    expect(html).not.toContain('Suggested');
    expect(html.match(/<option value="__not-counted">Not counted<\/option>/g)).toHaveLength(4);
  });

  it('sets Day or On-call on the card, once for all its places', () => {
    const { settings, places } = draftFixture();
    const withType = addSessionType(settings, 'custom', 'quiet');
    withType.types[0]!.kind = 'on-call';
    const html = renderToStaticMarkup(createElement(SessionTypesEditor, { settings: withType, places, onChange() {} }));
    for (const type of withType.types) expect(html.match(new RegExp(`aria-label="Session kind for ${type.name}"`, 'g'))).toHaveLength(1);
    expect(html).toContain('Fairer rota leaves these alone.');
    expect(html).toContain('Booked nights and long days usually go in On-call types');
    expect(html.match(/New session type…/g)).toHaveLength(4);
  });

  it('does not treat a blank Day/On-call choice as Day for hints or booked-shift warnings', () => {
    const { settings, places } = draftFixture();
    const withType = addSessionType(settings, 'cover-type', 'quiet', 'Garden Room');
    expect(withType.types[0]!.kind).toBe('day');
    const warning = { placeId: 'quiet', activity: 'Garden Room', kind: 'booked night' as const };
    const blank = renderToStaticMarkup(createElement(SessionTypesEditor, {
      settings: withType, places, bookedWarnings: [warning], kindRequired: true, initialUnselectedKindIds: ['cover-type'], onChange() {},
    }));
    expect(blank).toContain('Choose Day or On-call');
    expect(blank).not.toContain('Fairer rota can move these.');
    expect(blank).not.toContain('Fairer rota leaves these alone.');
    expect(blank).not.toContain('booked night');
    expect(blank).not.toContain('is set to Day');
    const chosen = renderToStaticMarkup(createElement(SessionTypesEditor, {
      settings: withType, places, bookedWarnings: [warning], kindRequired: true, onChange() {},
    }));
    expect(chosen).toContain('Fairer rota can move these.');
    expect(chosen).toMatch(/is a booked night in MediRota, but its type (?:"|&#x27;|&quot;)Garden Room(?:"|&#x27;|&quot;) is set to Day/);
  });

  it('keeps an empty saved settings object neutral', () => {
    const empty = defaultSessionsSettings(emptyProfile());
    expect(empty.types).toEqual([]);
  });

  it('shows a clear Not counted line and strong colour swatches', () => {
    const { settings, places } = draftFixture();
    const withType = addSessionType(settings, 'custom', 'quiet');
    const html = renderToStaticMarkup(createElement(SessionTypesEditor, { settings: withType, places, onChange() {} }));
    expect(html).toContain('>Not counted<');
    expect(html).toMatch(/These places don(?:'|&#x27;)t appear in Sessions or Fairer rota\./);
    expect(html).not.toMatch(/Not counted: these places don/);
    expect(html).toContain('session-swatch session-swatch-strong');
  });

  it('keeps the first nine colour values and gives added types unused colours', () => {
    const { settings } = draftFixture();
    expect(SESSION_COLOURS).toHaveLength(16);
    expect(SESSION_COLOURS.slice(0, 9).map(colour => colour.number)).toEqual([1,2,3,4,5,6,7,8,9]);
    const first = addSessionType(settings, 'one');
    const second = addSessionType(first, 'two');
    expect(second.types.map(type => type.colour)).toEqual([1, 2]);
    expect(firstUnusedSessionColour(second)).toBe(3);
  });
});
