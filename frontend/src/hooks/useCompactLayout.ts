import { useEffect, useState } from 'react';

/** Breakpoint (px) below which the app uses drawer nav + full-width content. */
export const COMPACT_LAYOUT_MAX = 1279;

/**
 * Detects phone/tablet widths and toggles `layout-compact` on <html>.
 * Class-based layout avoids relying on CSS range media queries that some
 * browsers/WebViews ignore after minification.
 */
export function useCompactLayout(maxWidth = COMPACT_LAYOUT_MAX): boolean {
  const query = `(max-width: ${maxWidth}px)`;

  const [compact, setCompact] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(query).matches : false,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const apply = () => {
      const on = mq.matches;
      setCompact(on);
      document.documentElement.classList.toggle('layout-compact', on);
    };
    apply();
    mq.addEventListener('change', apply);
    return () => {
      mq.removeEventListener('change', apply);
      document.documentElement.classList.remove('layout-compact');
    };
  }, [query]);

  return compact;
}
