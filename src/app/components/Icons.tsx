import type { ReactNode } from 'react';

/** Small line icons in the style of SF Symbols, for the sidebar. */
function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const ICONS = {
  overview: <Icon><rect x="3" y="3" width="14" height="14" rx="2" /><path d="M3 8h14M8 3v14" /></Icon>,
  sessions: <Icon><path d="M3 16.5h14M4.5 13l3.2-3.5 2.6 2 5.2-6" /><circle cx="15.5" cy="5.5" r="1" /></Icon>,
  fairer: <Icon><path d="M3 6h14M3 10h14M3 14h14" /><circle cx="7" cy="6" r="2" fill="var(--sidebar)" /><circle cx="13" cy="10" r="2" fill="var(--sidebar)" /></Icon>,
  settings: <Icon><circle cx="10" cy="10" r="2.5" /><path d="M10 2.8v2M10 15.2v2M2.8 10h2M15.2 10h2M4.9 4.9l1.4 1.4M13.7 13.7l1.4 1.4M15.1 4.9l-1.4 1.4M6.3 13.7l-1.4 1.4" /></Icon>,
  import: <Icon><path d="M10 3v9.5" /><path d="M6.4 9l3.6 3.6L13.6 9" /><path d="M3.5 13v2.2c0 1 .8 1.8 1.8 1.8h9.4c1 0 1.8-.8 1.8-1.8V13" /></Icon>,
  shifts: <Icon><circle cx="10" cy="10" r="7" /><path d="M10 6v4l2.6 1.8" /></Icon>,
  places: <Icon><path d="M10 17.5s-5.5-5-5.5-9a5.5 5.5 0 0 1 11 0c0 4-5.5 9-5.5 9z" /><circle cx="10" cy="8.5" r="2" /></Icon>,
  staffing: <Icon><circle cx="7" cy="7" r="2.4" /><circle cx="13.5" cy="7.5" r="2" /><path d="M2.8 16c.5-2.6 2.2-4 4.2-4s3.7 1.4 4.2 4" /><path d="M12 12.3c.5-.2 1-.3 1.5-.3 1.7 0 3.1 1.2 3.6 3.4" /></Icon>,
  rules: <Icon><path d="M8 5.5h9M8 10h9M8 14.5h9" /><path d="M3 5.3l1 1 1.8-2" /><path d="M3 9.8l1 1 1.8-2" /><path d="M3 14.3l1 1 1.8-2" /></Icon>,
  people: <Icon><circle cx="10" cy="6.8" r="3" /><path d="M4 17c.7-3.2 3-5 6-5s5.3 1.8 6 5" /></Icon>,
  swaps: <Icon><path d="M4 6h10.5" /><path d="M12 3.5 14.5 6 12 8.5" /><path d="M16 14H5.5" /><path d="M8 11.5 5.5 14 8 16.5" /></Icon>,
  swapSettings: <Icon><circle cx="10" cy="10" r="2.5" /><path d="M10 3v2M10 15v2M3 10h2M15 10h2M5 5l1.4 1.4M13.6 13.6 15 15M15 5l-1.4 1.4M6.4 13.6 5 15" /></Icon>,
};

/** The sidebar toggle: a window with its left panel marked. */
export function SidebarIcon() {
  return (
    <svg className="nav-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.8" y="3.8" width="14.4" height="12.4" rx="2.4" />
      <path d="M7.6 3.8v12.4" />
    </svg>
  );
}
