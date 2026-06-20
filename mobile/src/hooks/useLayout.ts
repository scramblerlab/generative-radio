import { useWindowDimensions } from 'react-native';
import type { SizeClass } from '../components/theme';

export interface Layout {
  width: number;
  height: number;
  isLandscape: boolean;
  sizeClass: SizeClass;
  /** Max content width for the centered single-column (regular-portrait) layout. */
  contentMaxWidth: number;
}

// Regular-width threshold on the *shorter* screen edge. Tuned to 700 so the
// iPad mini 6 (744×1133pt — 744pt short side) classifies as `regular` in BOTH
// orientations, matching its real UIKit size class. A 768 cutoff would wrongly
// treat the mini as a phone. iPhone Air stays `compact`; an iPad in a narrow
// Split View (< ~half) also collapses to `compact`, which is correct.
const REGULAR_MIN_EDGE = 700;

// ≈ iPad mini portrait width, so the centered column is near full-bleed on the
// mini and politely centered on larger iPads.
const CONTENT_MAX_WIDTH = 720;

/**
 * Adaptive layout descriptor driven by useWindowDimensions (re-renders on
 * rotation and Split View resize — the responsiveness the app previously
 * lacked entirely).
 */
export function useLayout(): Layout {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const sizeClass: SizeClass =
    Math.min(width, height) >= REGULAR_MIN_EDGE ? 'regular' : 'compact';
  return {
    width,
    height,
    isLandscape,
    sizeClass,
    contentMaxWidth: CONTENT_MAX_WIDTH,
  };
}
