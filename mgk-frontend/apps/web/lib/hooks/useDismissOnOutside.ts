import { useEffect, type RefObject } from 'react';

/** Closes a `<details>` popover on Escape or a click outside it, as users expect of popovers. */
export function useDismissOnOutside(ref: RefObject<HTMLDetailsElement | null>) {
  useEffect(() => {
    const close = (event: Event) => {
      const el = ref.current;
      if (!el?.open) return;
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !el.contains(event.target as Node))
        el.open = false;
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [ref]);
}
