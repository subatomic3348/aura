import { useEffect, useState } from 'react';
import { formatDuration } from '../../lib/format';

/** A self-ticking clock. Re-renders only itself, once per second. */
export function Elapsed({ since, className }: { since: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    <time className={className} dateTime={`PT${Math.floor((now - since) / 1000)}S`}>
      {formatDuration(now - since)}
    </time>
  );
}
