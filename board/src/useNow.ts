import { useEffect, useState } from 'react';

/** Client-ticking clock for countdowns and relative times. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(iv);
  }, [intervalMs]);
  return now;
}
