import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, Easing } from 'react-native';
import { colors } from './theme';
import type { SizeClass } from './theme';

// Lerp between the amber accent and indigo across the bar field so the visual
// reads as a lush generative "album art" rather than a tiny meter.
function lerpColor(t: number): string {
  const a = [245, 158, 11];  // accent  #f59e0b
  const b = [99, 102, 241];  // indigo  #6366f1
  const c = a.map((av, i) => Math.round(av + (b[i] - av) * t));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

interface Props {
  active: boolean;
  sizeClass: SizeClass;
}

/**
 * Animated bar field — the centerpiece "art" for a generative-music app.
 * Promoted from the old inline Waveform (5 bars / 32pt). Scales by size class:
 * a tall lush field on iPad, a compact meter on phone.
 *
 * Uses useNativeDriver:false (height is not natively animatable). The PARENT
 * passes active=false when backgrounded, which parks every bar and stops the
 * loops — this is what keeps the JS-thread animation from tripping the iOS
 * cpulimit kill during background audio. Do not start loops when !active.
 */
export function GenerativeVisual({ active, sizeClass }: Props) {
  const regular = sizeClass === 'regular';
  const barCount = regular ? 13 : 7;
  const fieldHeight = regular ? 200 : 88;
  const barWidth = regular ? 6 : 4;
  const maxBar = fieldHeight - 8;
  const minBar = regular ? 8 : 4;

  // Stable per-bar peak heights (a gentle arch, tallest in the middle).
  const peaks = useRef(
    Array.from({ length: barCount }, (_, i) => {
      const center = (barCount - 1) / 2;
      const dist = Math.abs(i - center) / center; // 0 at center → 1 at edges
      return 0.45 + (1 - dist) * 0.55; // 0.45..1.0
    }),
  ).current;

  const anims = useRef(peaks.map(() => new Animated.Value(0.2))).current;

  useEffect(() => {
    if (!active) {
      anims.forEach((a) =>
        Animated.spring(a, { toValue: 0.2, useNativeDriver: false }).start(),
      );
      return;
    }
    const loops = anims.map((anim, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: peaks[i],
            duration: 340 + i * 70,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
          Animated.timing(anim, {
            toValue: 0.14,
            duration: 340 + i * 70,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
        ]),
      ),
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active, anims, peaks]);

  return (
    <View style={[styles.container, { height: fieldHeight, gap: regular ? 7 : 4 }]}>
      {anims.map((anim, i) => (
        <Animated.View
          key={i}
          style={{
            width: barWidth,
            borderRadius: barWidth / 2,
            backgroundColor: lerpColor(i / (barCount - 1)),
            opacity: active ? 1 : 0.3,
            height: anim.interpolate({
              inputRange: [0, 1],
              outputRange: [minBar, maxBar],
            }),
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
