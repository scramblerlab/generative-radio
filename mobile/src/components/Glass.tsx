import React, { useEffect, useState } from 'react';
import { View, StyleSheet, AccessibilityInfo, Platform, ViewProps } from 'react-native';
import { BlurView } from 'expo-blur';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { colors, glass, radius } from './theme';

type GlassMode = 'native' | 'blur' | 'solid';

// Decide which surface to render. Wrapped in try/catch because
// isLiquidGlassAvailable() calls requireNativeModule('ExpoGlassEffect'),
// which THROWS when the native module isn't compiled into the binary (a JS
// reload over a stale build). In that case fall back to a solid surface so a
// missing pod degrades gracefully instead of crashing the whole app.
function glassMode(reduceTransparency: boolean): GlassMode {
  if (Platform.OS !== 'ios') return 'solid';
  if (reduceTransparency) return 'solid';
  try {
    return isLiquidGlassAvailable() ? 'native' : 'blur';
  } catch {
    return 'solid';
  }
}

interface GlassProps extends ViewProps {
  /** Corner radius — defaults to the concentric card radius. */
  borderRadius?: number;
  /** 'regular' frosted panel (default) or 'strong' for floating surfaces. */
  variant?: 'regular' | 'strong';
  /** Drop a soft shadow (floating surfaces: status pill, DJ sheet). */
  floating?: boolean;
  children?: React.ReactNode;
}

/**
 * One reusable frosted surface for the whole app. The glass material is a
 * NON-interactive absolute-fill background behind the children, so:
 *   - the shadow lives on the outer view (no overflow:'hidden' there — that
 *     would clip the iOS shadow), while the blur is clipped on the background;
 *   - touches pass through to the children (buttons in the rail / DJ sheet).
 *
 * Fallback chain:
 *   iOS 26+   → native Liquid Glass (UIVisualEffectView)
 *   iOS < 26  → expo-blur BlurView (frosted approximation)
 *   Android / reduce-transparency → solid translucent surface
 *
 * Keep live glass surfaces small (~4): GPU blur is cheap for a few elements
 * but stacking/animating many stresses the GPU.
 */
export function Glass({
  borderRadius = radius.card,
  variant = 'regular',
  floating = false,
  style,
  children,
  ...rest
}: GlassProps) {
  const [reduceTransparency, setReduceTransparency] = useState(false);

  useEffect(() => {
    let mounted = true;
    AccessibilityInfo.isReduceTransparencyEnabled().then((v) => {
      if (mounted) setReduceTransparency(v);
    });
    const sub = AccessibilityInfo.addEventListener(
      'reduceTransparencyChanged',
      (v) => setReduceTransparency(v),
    );
    return () => {
      mounted = false;
      sub.remove();
    };
  }, []);

  const shadow = floating
    ? {
        shadowColor: glass.shadowColor,
        shadowOpacity: glass.shadowOpacity,
        shadowRadius: glass.shadowRadius,
        shadowOffset: { width: 0, height: 8 },
        elevation: 12,
      }
    : null;

  const bgFill = [StyleSheet.absoluteFill, { borderRadius }];
  const mode = glassMode(reduceTransparency);

  function renderBackground() {
    // Native Liquid Glass (iOS 26+).
    if (mode === 'native') {
      return (
        <GlassView
          glassEffectStyle="regular"
          colorScheme="dark"
          style={[bgFill, { overflow: 'hidden' }]}
          pointerEvents="none"
        />
      );
    }
    // iOS < 26 → frosted blur approximation with a tint + top hairline.
    if (mode === 'blur') {
      return (
        <View pointerEvents="none" style={[bgFill, { overflow: 'hidden' }]}>
          <BlurView intensity={variant === 'strong' ? 40 : 28} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: variant === 'strong' ? glass.tintStrong : glass.tint }]} />
          <View style={[StyleSheet.absoluteFill, { borderTopWidth: 1, borderColor: glass.hairline, borderRadius }]} />
        </View>
      );
    }
    // Solid fallback — Android, reduce-transparency, OR native modules not
    // linked into the binary yet (e.g. a JS reload over an old build).
    return (
      <View
        pointerEvents="none"
        style={[
          bgFill,
          { backgroundColor: variant === 'strong' ? colors.surface : colors.surface2,
            borderTopWidth: 1, borderColor: glass.hairline },
        ]}
      />
    );
  }

  return (
    <View style={[{ borderRadius }, shadow, style]} {...rest}>
      {renderBackground()}
      {children}
    </View>
  );
}
