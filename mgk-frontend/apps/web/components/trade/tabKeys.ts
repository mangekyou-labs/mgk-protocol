import type { KeyboardEvent } from 'react';

/**
 * Arrow/Home/End movement for a tablist. Moves focus to the target tab and
 * returns its index, or null for keys that don't navigate.
 */
export function moveTabFocus(
  event: KeyboardEvent<HTMLButtonElement>,
  index: number,
  count: number,
): number | null {
  let next: number;
  if (event.key === 'ArrowRight') next = (index + 1) % count;
  else if (event.key === 'ArrowLeft') next = (index + count - 1) % count;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = count - 1;
  else return null;
  event.preventDefault();
  event.currentTarget.parentElement
    ?.querySelectorAll<HTMLButtonElement>('[role=tab]')
    [next]?.focus();
  return next;
}
