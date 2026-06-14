import type { CSSProperties } from 'react';

/**
 * An animated light that travels around the rounded border of its positioned
 * parent (magicui-style "border beam"). Pure CSS — a registered --angle drives
 * a conic-gradient masked to a thin ring (see `.border-beam` in index.css).
 *
 * Drop it as the last child of a `relative` + rounded container. The beam
 * inherits the parent's border-radius. Respects prefers-reduced-motion (freezes
 * to a static subtle gradient ring). Animates only --angle, so no layout cost.
 */
export function BorderBeam({
  color = 'oklch(0.78 0.145 70)',
  durationSec = 6,
  widthPx = 1.25,
  reverse = false,
}: {
  /** Beam color (warm ember by default). */
  color?: string;
  /** Seconds per full loop. Slower = subtler. */
  durationSec?: number;
  /** Ring thickness in px. */
  widthPx?: number;
  /** Travel counter-clockwise. */
  reverse?: boolean;
}) {
  const style: CSSProperties = {
    '--beam-color': color,
    '--beam-duration': `${durationSec}s`,
    '--beam-width': `${widthPx}px`,
  } as CSSProperties;
  return (
    <span aria-hidden="true" data-reverse={reverse} className="border-beam" style={style} />
  );
}
