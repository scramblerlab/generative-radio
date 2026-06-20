import React from 'react';
import {
  View, Text, ScrollView, StyleSheet, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { Track, ActivityEntry, ViewerInfo, ProgressStage } from '@radio/shared';
import { colors, fonts, radius } from './theme';

// ------------------------------------------------------------------ //
// Helpers
// ------------------------------------------------------------------ //

const STAGE_LABEL: Record<ProgressStage, string> = {
  llm_thinking:     'THINKING',
  llm_done:         'COMPOSED',
  acestep_start:    'GENERATING',
  acestep_progress: 'PROGRESS',
  acestep_done:     'DONE',
};

function elapsedLabel(connectedAt: number): string {
  const secs = Math.floor(Date.now() / 1000 - connectedAt);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// ------------------------------------------------------------------ //
// StatsPane sub-components — all styles from theme.ts tokens
// ------------------------------------------------------------------ //

function SectionHeader({ label }: { label: string }) {
  return <Text style={s.sectionHeader}>{label}</Text>;
}

function MetaPill({ label, value }: { label: string; value: string }) {
  return (
    <View style={s.metaPill}>
      <Text style={s.metaPillLabel}>{label}</Text>
      <Text style={s.metaPillValue}>{value}</Text>
    </View>
  );
}

// ------------------------------------------------------------------ //
// StatsPane
// ------------------------------------------------------------------ //

interface StatsPaneProps {
  track: Track | null;
  activityLog: ActivityEntry[];
  listenerCount: number;
  viewers: ViewerInfo[];
  audioDuration: number | null;
}

function StatsPane({ track, activityLog, listenerCount, viewers, audioDuration }: StatsPaneProps) {
  const insets = useSafeAreaInsets();

  return (
    <ScrollView
      style={s.statsPaneRoot}
      contentContainerStyle={[s.statsPaneContent, { paddingTop: insets.top + 16, paddingRight: Math.max(insets.right, 16) }]}
      showsVerticalScrollIndicator={false}
    >
      {/* ---- Track metadata card ---- */}
      {track ? (
        <View style={s.card}>
          <SectionHeader label="NOW PLAYING" />

          {/* Genre badge — identical style to RadioPlayer badge */}
          <View style={s.badge}>
            <Text style={s.badgeText}>
              {track.isRandom
                ? track.genre ? `RANDOM · ${track.genre.toUpperCase()}` : 'RANDOM'
                : track.genre.toUpperCase()}
            </Text>
          </View>

          {/* BPM / Key / Duration pills */}
          <View style={s.pillRow}>
            {track.bpm ? <MetaPill label="BPM" value={String(track.bpm)} /> : null}
            {track.keyScale ? <MetaPill label="KEY" value={track.keyScale} /> : null}
            {(audioDuration ?? track.duration) > 0 ? (
              <MetaPill label="DURATION" value={`${audioDuration ?? track.duration}s`} />
            ) : null}
          </View>

          {/* Tags */}
          {track.tags ? <Text style={s.tags}>{track.tags}</Text> : null}

          {/* DJ session block */}
          {track.djName ? (
            <View style={s.djBlock}>
              <Text style={s.djName}>DJ: {track.djName}</Text>
              <View style={s.pillRow}>
                {track.djKeywords.map((kw) => (
                  <View key={kw} style={s.kwPill}>
                    <Text style={s.kwPillText}>{kw}</Text>
                  </View>
                ))}
                {track.djLanguage ? (
                  <View style={s.kwPill}>
                    <Text style={s.kwPillText}>
                      {track.djLanguage === 'instrumental' ? 'Instrumental' : track.djLanguage.toUpperCase()}
                    </Text>
                  </View>
                ) : null}
              </View>
            </View>
          ) : null}
        </View>
      ) : (
        <View style={s.card}>
          <SectionHeader label="NOW PLAYING" />
          <Text style={s.emptyText}>Waiting for track…</Text>
        </View>
      )}

      {/* ---- Full lyrics card ---- */}
      {track?.lyrics ? (
        <View style={s.card}>
          <SectionHeader label="LYRICS" />
          <Text style={s.lyricsText}>{track.lyrics}</Text>
        </View>
      ) : null}

      {/* ---- Generation activity card (capped at 15 entries) ---- */}
      {activityLog.length > 0 ? (
        <View style={s.card}>
          <SectionHeader label="GENERATION" />
          <ScrollView style={s.activityScroll} showsVerticalScrollIndicator>
            {activityLog.slice(-15).map((entry) => (
              <View key={entry.id} style={s.activityRow}>
                <View style={s.activityTag}>
                  <Text style={s.activityTagText}>
                    {STAGE_LABEL[entry.stage] ?? entry.stage}
                  </Text>
                </View>
                <Text style={s.activityMessage} numberOfLines={2}>{entry.message}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      ) : null}

      {/* ---- Listeners card ---- */}
      {(listenerCount > 0 || viewers.length > 0) ? (
        <View style={s.card}>
          <SectionHeader label="LISTENERS" />
          <View style={s.listenerCountRow}>
            <MaterialIcons name="people" size={14} color={colors.accent} />
            <Text style={s.listenerCountText}>{listenerCount} connected</Text>
          </View>
          {viewers.map((v, i) => (
            <View key={i} style={s.viewerRow}>
              <MaterialIcons name="person" size={12} color={colors.textMuted} />
              <Text style={s.viewerIp} numberOfLines={1}>{v.ip}</Text>
              <Text style={s.viewerElapsed}>{elapsedLabel(v.connectedAt)}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  );
}

// ------------------------------------------------------------------ //
// IPadLayout — exported wrapper
// ------------------------------------------------------------------ //

export interface IPadLayoutProps {
  children: React.ReactNode;
  track: Track | null;
  activityLog: ActivityEntry[];
  listenerCount: number;
  viewers: ViewerInfo[];
  audioDuration: number | null;
}

export function IPadLayout({ children, track, activityLog, listenerCount, viewers, audioDuration }: IPadLayoutProps) {
  const { width, height } = useWindowDimensions();
  const isIPad = width >= 768;
  const isLandscape = width > height;

  if (!isIPad || !isLandscape) {
    // Portrait on iPad, or any phone: single-column, identical to iPhone
    return <>{children}</>;
  }

  return (
    <View style={s.splitRoot}>
      <View style={s.leftPane}>{children}</View>
      <View style={s.rightPane}>
        <StatsPane
          track={track}
          activityLog={activityLog}
          listenerCount={listenerCount}
          viewers={viewers}
          audioDuration={audioDuration}
        />
      </View>
    </View>
  );
}

// ------------------------------------------------------------------ //
// Styles — all tokens from theme.ts, mirroring RadioPlayer conventions
// ------------------------------------------------------------------ //

const s = StyleSheet.create({
  // Split layout
  splitRoot: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: colors.bg,
  },
  leftPane: {
    flex: 1,
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  rightPane: {
    flex: 1,
    backgroundColor: colors.bg,
  },

  // StatsPane shell
  statsPaneRoot: {
    flex: 1,
    backgroundColor: colors.bg,
  },
  statsPaneContent: {
    paddingLeft: 16,
    paddingBottom: 40,
  },

  // Card — mirrors RadioPlayer card exactly
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 12,
  },

  // Section header — uppercase label above each card section
  sectionHeader: {
    fontFamily: fonts.semiBold,
    fontSize: 10,
    letterSpacing: 1.5,
    color: colors.textMuted,
    textTransform: 'uppercase',
    marginBottom: 12,
  },

  // Genre badge — pixel-identical to RadioPlayer badge
  badge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 12,
  },
  badgeText: {
    fontFamily: fonts.semiBold,
    color: colors.accent,
    fontSize: 11,
    letterSpacing: 0.5,
  },

  // Metadata pills (BPM / KEY / DURATION)
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginBottom: 10,
  },
  metaPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  metaPillLabel: {
    fontFamily: fonts.medium,
    fontSize: 9,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  metaPillValue: {
    fontFamily: fonts.semiBold,
    fontSize: 12,
    color: colors.text,
  },

  // Tags — mirrors RadioPlayer tags style
  tags: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textMuted,
    lineHeight: 18,
    marginTop: 2,
  },

  // DJ session
  djBlock: {
    marginTop: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  djName: {
    fontFamily: fonts.semiBold,
    fontSize: 12,
    color: colors.textDim,
    marginBottom: 8,
  },
  kwPill: {
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  kwPillText: {
    fontFamily: fonts.regular,
    fontSize: 11,
    color: colors.textDim,
  },

  // Lyrics
  lyricsText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textMuted,
    lineHeight: 20,
  },

  // Generation activity
  activityScroll: {
    maxHeight: 390, // ~15 rows × 26px
  },
  activityRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 8,
  },
  activityTag: {
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    flexShrink: 0,
  },
  activityTagText: {
    fontFamily: fonts.medium,
    fontSize: 9,
    color: colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  activityMessage: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textDim,
    flex: 1,
    lineHeight: 17,
  },

  // Listeners
  listenerCountRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
  },
  listenerCountText: {
    fontFamily: fonts.semiBold,
    fontSize: 13,
    color: colors.textDim,
  },
  viewerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 5,
  },
  viewerIp: {
    fontFamily: fonts.regular,
    fontSize: 12,
    color: colors.textMuted,
    flex: 1,
  },
  viewerElapsed: {
    fontFamily: fonts.medium,
    fontSize: 11,
    color: colors.textMuted,
  },

  // Empty / loading state
  emptyText: {
    fontFamily: fonts.regular,
    fontSize: 13,
    color: colors.textMuted,
  },
});
