import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Draggable javascript: bookmark link. React blocks javascript: in href props,
 * so the real URL is set with setAttribute after mount (same pattern as Import).
 */
export function FetchBookmarkLink({ href, children, className }: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLAnchorElement>(null);
  useEffect(() => { if (ref.current) ref.current.setAttribute('href', href); }, [href]);
  return <a ref={ref} href="#" className={className} draggable="true">{children}</a>;
}
