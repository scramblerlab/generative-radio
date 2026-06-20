// Design tokens mirroring the web app's CSS variables
export const colors = {
  bg:          '#0a0a0f',
  surface:     '#111118',
  surface2:    '#1a1a26',
  border:      '#1e1e30',
  border2:     '#2a2a40',
  accent:      '#f59e0b',
  accentGlow:  'rgba(245, 158, 11, 0.25)',
  accentDim:   'rgba(245, 158, 11, 0.12)',
  indigo:      '#6366f1',
  text:        '#f1f5f9',
  textMuted:   '#64748b',
  textDim:     '#94a3b8',
  green:       '#22c55e',
  red:         '#ef4444',
};

export const radius = {
  sm:   8,
  md:   12,
  // Concentric Liquid-Glass radii (rail > card > control nesting)
  card: 20,
  rail: 28,
  pill: 999,
};

export const fonts = {
  display:   'BebasNeue_400Regular',
  regular:   'SpaceGrotesk_400Regular',
  medium:    'SpaceGrotesk_500Medium',
  semiBold:  'SpaceGrotesk_600SemiBold',
  bold:      'SpaceGrotesk_700Bold',
};

// 4pt spacing scale — replaces the hardcoded 16/20/28 values scattered
// through the player styles.
export const spacing = {
  xs:  4,
  sm:  8,
  md:  12,
  lg:  16,
  xl:  24,
  x2:  32,
  x3:  48,
};

// Liquid-Glass surface tokens. Used by Glass.tsx for the BlurView /
// translucent-View fallbacks (the native GlassView supplies its own material).
export const glass = {
  // Subtle warm tint so frosted panels read against the near-black bg.
  tint:        'rgba(20, 20, 30, 0.55)',
  tintStrong:  'rgba(12, 12, 20, 0.72)',
  // Hairline highlight along the top edge of glass surfaces (depth cue).
  hairline:    'rgba(255, 255, 255, 0.10)',
  // Soft drop shadow for floating glass (status pill, DJ sheet).
  shadowColor: '#000',
  shadowOpacity: 0.35,
  shadowRadius: 24,
};

export type SizeClass = 'compact' | 'regular';

// Type scale tuned to the iPad mini 6 (744×1133pt) as the primary regular
// target — 54pt Bebas reads large on its 8.3" panel without overflowing the
// hero; larger iPads simply gain breathing room. Compact = phone.
export function type(sizeClass: SizeClass) {
  const regular = sizeClass === 'regular';
  return {
    title:   regular ? 54 : 34,
    tags:    regular ? 15 : 12,
    meta:    regular ? 13 : 11,
    lyrics:  regular ? 14 : 12,
    body:    regular ? 14 : 13,
    label:   regular ? 12 : 11,
    badge:   regular ? 12 : 11,
    button:  regular ? 15 : 14,
  };
}
