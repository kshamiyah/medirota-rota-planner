import type { Role } from '../engine/types';

/** Visible place label, while Role.name remains the stable MediRota identity. */
export const placeName = (place: Pick<Role, 'name' | 'displayName'> | undefined): string => place?.displayName?.trim() || place?.name || 'Place';
