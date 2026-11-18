'use client';

import { useEffect, useState } from 'react';

/** True once `condition` has held continuously for `delayMs`; false as soon as it lapses. */
export function useSustained(condition: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!condition) return;
    const timer = setTimeout(() => setHeld(true), delayMs);
    return () => { clearTimeout(timer); setHeld(false); };
  }, [condition, delayMs]);
  return condition && held;
}
