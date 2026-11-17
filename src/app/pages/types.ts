export const PAGE_IDS = ['overview', 'sessions', 'fairer', 'settings', 'import', 'shifts', 'places', 'staffing', 'people', 'rules', 'setup', 'swaps', 'swapSettings'] as const;
export type Page = typeof PAGE_IDS[number];
