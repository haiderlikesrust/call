import { useEffect, useState, type MouseEvent } from 'react';

/** The page's path, kept in step with the back and forward buttons. */
export function usePath(): string {
  const [path, set] = useState(location.pathname);
  useEffect(() => {
    const on = () => set(location.pathname);
    addEventListener('popstate', on);
    return () => removeEventListener('popstate', on);
  }, []);
  return path;
}

export function go(to: string): void {
  if (to === location.pathname) return;
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
  scrollTo({ top: 0 });
}

/** For an <a href>: moves within the site without a reload; new-tab clicks behave as usual. */
export const onLink = (e: MouseEvent<HTMLAnchorElement>): void => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const url = new URL(e.currentTarget.href);
  if (url.origin !== location.origin || url.hash) return;
  e.preventDefault();
  go(url.pathname);
};
