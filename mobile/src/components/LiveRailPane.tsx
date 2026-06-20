import React, { useEffect, useRef } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, ViewStyle } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Track, RadioStatus, ActivityEntry } from '@radio/shared';
import { colors, fonts, radius, spacing, type as typeScale } from './theme';
import type { SizeClass } from './theme';
import { Glass } from './Glass';

interface Props {
  status: RadioStatus;
  statusMessage: string;
  listenerCount: number;
  track: Track | null;
  activityLog: ActivityEntry[];
  effectiveDjLocked: boolean;
  djCountdown: string;
  errorMessage: string | null;
  sizeClass: SizeClass;
  onClaimDj?: () => void;
  style?: ViewStyle;
}

export function LiveRailPane({
  status, statusMessage, listenerCount, track, activityLog,
  effectiveDjLocked, djCountdown, errorMessage, sizeClass, onClaimDj, style,
}: Props) {
  const s = makeStyles(sizeClass);
  const logRef = useRef<ScrollView>(null);
  useEffect(() => {
    logRef.current?.scrollToEnd({ animated: true });
  }, [activityLog.length]);

  const dimmed = status === 'idle' || status === 'stopped' || status === 'connecting';
  const onAirLabel =
    statusMessage ||
    (status === 'generating' ? 'Waiting for radio...' :
     status === 'buffering' ? 'Downloading track...' :
     status === 'playing' ? 'On air' :
     status === 'connecting' ? 'Connecting...' : 'Off air');

  const djInfo = track?.djName
    ? [
        track.djName,
        track.genre ? (track.isRandom ? `Random · ${track.genre}` : track.genre) : null,
        track.djKeywords.length > 0 ? track.djKeywords.join(' · ') : null,
        track.djLanguage ? (track.djLanguage === 'instrumental' ? 'Instrumental' : track.djLanguage.toUpperCase()) : null,
      ].filter(Boolean).join('  ·  ')
    : null;

  return (
    <Glass borderRadius={radius.rail} variant="strong" style={[s.rail, style]}>
      {/* On-air status */}
      <View style={s.section}>
        <View style={s.statusRow}>
          <View style={[s.dot, { backgroundColor: dimmed ? colors.textMuted : colors.accent }]} />
          <Text style={s.statusLabel} numberOfLines={1}>{onAirLabel}</Text>
          {listenerCount > 0 && (
            <View style={s.countBadge}>
              <MaterialIcons name="people" size={13} color={colors.textMuted} />
              <Text style={s.countText}>{listenerCount}</Text>
            </View>
          )}
        </View>
        {track ? <Text style={s.nowTitle} numberOfLines={1}>{track.songTitle}</Text> : null}
      </View>

      {errorMessage && (
        <View style={s.errorBox}>
          <Text style={s.errorText}>⚠ {errorMessage}</Text>
        </View>
      )}

      {/* DJ booth */}
      {onClaimDj && (
        <View style={s.section}>
          <Text style={s.sectionTitle}>DJ BOOTH</Text>
          <TouchableOpacity
            style={[s.djBtn, effectiveDjLocked && s.djBtnLocked]}
            onPress={effectiveDjLocked ? undefined : onClaimDj}
            disabled={effectiveDjLocked}
          >
            <Text style={[s.djBtnText, effectiveDjLocked && s.djBtnTextLocked]}>Generate Your Tracks</Text>
          </TouchableOpacity>
          {effectiveDjLocked && djCountdown ? (
            <Text style={s.djCountdown}>Unlocks in {djCountdown}</Text>
          ) : null}
          {djInfo ? <Text style={s.djInfo}>{djInfo}</Text> : null}
        </View>
      )}

      {/* Live activity */}
      {activityLog.length > 0 && (
        <View style={[s.section, s.activitySection]}>
          <Text style={s.sectionTitle}>LIVE ACTIVITY</Text>
          <ScrollView ref={logRef} style={s.activityScroll} showsVerticalScrollIndicator={false}>
            {activityLog.map((e) => (
              <Text key={e.id} style={s.activityLine} numberOfLines={2}>· {e.message}</Text>
            ))}
          </ScrollView>
        </View>
      )}
    </Glass>
  );
}

function makeStyles(sizeClass: SizeClass) {
  const t = typeScale(sizeClass);
  return StyleSheet.create({
    rail: { padding: spacing.xl, gap: spacing.lg },

    section: { gap: spacing.sm },
    sectionTitle: { fontFamily: fonts.semiBold, color: colors.textMuted, fontSize: t.label, letterSpacing: 1 },

    statusRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    dot: { width: 9, height: 9, borderRadius: 5 },
    statusLabel: { flex: 1, fontFamily: fonts.medium, color: colors.textDim, fontSize: t.body },
    countBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border2 },
    countText: { color: colors.textMuted, fontSize: t.label },
    nowTitle: { fontFamily: fonts.display, color: colors.text, fontSize: t.tags + 6, letterSpacing: 0.5 },

    djBtn: { paddingVertical: spacing.md, borderRadius: radius.sm, backgroundColor: colors.accent, alignItems: 'center' },
    djBtnLocked: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border2 },
    djBtnText: { color: '#000', fontSize: t.button, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
    djBtnTextLocked: { color: colors.textMuted },
    djCountdown: { color: colors.textMuted, fontSize: t.label },
    djInfo: { color: colors.textMuted, fontSize: t.label, lineHeight: t.label * 1.5 },

    activitySection: { flex: 1, minHeight: 0 },
    activityScroll: { maxHeight: sizeClass === 'regular' ? 220 : 120 },
    activityLine: { color: colors.textMuted, fontSize: t.label, lineHeight: t.label * 1.7, letterSpacing: 0.2 },

    errorBox: { padding: spacing.md, backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: radius.sm, borderWidth: 1, borderColor: colors.red },
    errorText: { color: colors.red, fontSize: t.body },
  });
}
