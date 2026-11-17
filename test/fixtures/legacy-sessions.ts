import type { Profile } from '../../src/engine/types';
import type { SessionsSettings } from '../../src/app/sessions';
/** Explicit saved settings used to check that legacy workspaces keep their existing configuration. */
export function legacySessions(profile: Profile): SessionsSettings {
  const places = (names: string[]) => profile.roles.filter(role => !role.parentId && names.includes(role.name)).map(role => role.id);
  const specs = [
    ['Theatre', 4, 'day', ['Elective C-Sections', 'WC Theatres']], ['Wards', 2, 'day', ['Postnatal Wards CT', 'Antenatal CT']],
    ['MAU', 3, 'day', ['MAU CT']], ['Float', 5, 'day', ['Float CT']], ['Delivery Suite', 1, 'on-call', ['Delivery Suite']],
    ['Gynae', 6, 'on-call', ['Gynae Ward CT']], ['Gynae onc', 7, 'on-call', ['Gynae Onc Long Day CT']], ['Nights', 8, 'on-call', ['Nights CT']],
  ] as const;
  const types = specs.map(([name, colour, kind, names], index) => ({ id: `session-${index + 1}`, name, colour, kind, placeIds: places([...names]) }));
  const groups = [
    { id: 'session-group-fy2', name: 'FY2', grades: ['FY2'] },
    { id: 'session-group-gps', name: 'GPs', grades: ['GP Reg', 'GPVTS'] },
    { id: 'session-group-st12', name: 'ST1-2', grades: ['ST1', 'ST1/2', 'ST2'] },
  ];
  return { types, groups, ratios: Object.fromEntries(types.map(type => [type.id, Object.fromEntries(groups.map(group => [group.id, 1]))])), sameConsultants: { groupIds: [], typeIds: [] } };
}
