import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, AppState, AppStateStatus,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { Track, RadioStatus, ActivityEntry, ReactionState } from '@radio/shared';
import { colors, radius, spacing } from './theme';
import { useLayout } from '../hooks/useLayout';
import { Glass } from './Glass';
import { NowPlayingPane } from './NowPlayingPane';
import { LiveRailPane } from './LiveRailPane';

// ------------------------------------------------------------------ //
// Floating glass status pill (persistent chrome, all layouts)
// ------------------------------------------------------------------ //
function StatusPill({
  status, message, listenerCount, bottomInset,
}: {
  status: RadioStatus; message: string; listenerCount: number; bottomInset: number;
}) {
  const dimmed = status === 'idle' || status === 'stopped' || status === 'connecting';
  const label =
    message ||
    (status === 'generating' ? 'Waiting for radio...' :
     status === 'buffering' ? 'Downloading track...' :
     status === 'playing' ? 'Playing' :
     status === 'connecting' ? 'Connecting...' : '');

  return (
    <View style={[pillStyles.wrap, { bottom: bottomInset + spacing.md }]} pointerEvents="box-none">
      <Glass borderRadius={radius.pill} variant="strong" floating style={pillStyles.pill}>
        <View style={pillStyles.left}>
          <View style={[pillStyles.dot, { backgroundColor: dimmed ? colors.textMuted : colors.accent }]} />
          <Text style={pillStyles.label} numberOfLines={1}>{label}</Text>
        </View>
        {listenerCount > 0 && (
          <View style={pillStyles.countBadge}>
            <MaterialIcons name="people" size={12} color={colors.textMuted} />
            <Text style={pillStyles.countText}>{listenerCount}</Text>
          </View>
        )}
      </Glass>
    </View>
  );
}

const pillStyles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, alignItems: 'center' },
  pill: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
    minWidth: 200, maxWidth: 460, gap: spacing.md,
  },
  left: { flexDirection: 'row', alignItems: 'center', flexShrink: 1, gap: spacing.sm },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { color: colors.textDim, fontSize: 12, flexShrink: 1 },
  countBadge: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  countText: { color: colors.textMuted, fontSize: 11 },
});

// ------------------------------------------------------------------ //
// Main RadioPlayer — responsive orchestrator
// ------------------------------------------------------------------ //

interface Props {
  readonly: boolean;
  track: Track | null;
  status: RadioStatus;
  statusMessage: string;
  errorMessage: string | null;
  activityLog: ActivityEntry[];
  progress: number;
  audioDuration: number | null;
  listenerCount: number;
  localPaused: boolean;
  djLocked: boolean;
  djUnlockAt: number;
  activeDjName: string;
  reactionState: ReactionState;
  onTogglePlayPause: () => void;
  onSeekBackward: () => void;
  onSeekForward: () => void;
  onChangeGenre?: () => void;
  onClaimDj?: () => void;
  onReact?: (trackId: string, action: 'thumb_up' | 'thumb_down') => void;
}

export function RadioPlayer({
  readonly, track, status, statusMessage, errorMessage,
  activityLog, progress, audioDuration, listenerCount, localPaused,
  djLocked, djUnlockAt, activeDjName, reactionState,
  onTogglePlayPause, onSeekBackward, onSeekForward,
  onChangeGenre, onClaimDj, onReact,
}: Props) {
  const insets = useSafeAreaInsets();
  const { sizeClass, isLandscape, contentMaxWidth } = useLayout();
  const isPlaying = status === 'playing' && !localPaused;

  // Stop JS-thread animations/timers in background — useNativeDriver:false
  // Animated loops + setInterval burn CPU and trip the iOS cpulimit kill.
  const [isBackground, setIsBackground] = useState(false);
  const isBackgroundRef = useRef(false);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      const bg = s === 'background';
      isBackgroundRef.current = bg;
      setIsBackground(bg);
    });
    return () => sub.remove();
  }, []);

  // Tick once per second to refresh the DJ unlock countdown.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      if (!isBackgroundRef.current) setTick((n) => n + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);
  const nowSec = Date.now() / 1000;
  const remainingSec = djUnlockAt > 0 ? Math.max(0, Math.ceil(djUnlockAt - nowSec)) : Infinity;
  const effectiveDjLocked = remainingSec > 0;
  const djCountdown =
    effectiveDjLocked && remainingSec !== Infinity
      ? `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, '0')}`
      : '';

  // Genre / controller badge (matches web)
  const badgeLabel = track
    ? [
        !readonly ? 'CONTROLLER' : null,
        track.isRandom
          ? track.genre ? `RANDOM · ${track.genre.toUpperCase()}` : 'RANDOM'
          : track.genre.toUpperCase(),
        track.djName ? `(DJ: ${track.djName})` : null,
      ].filter(Boolean).join(' · ')
    : null;

  const nowPlaying = (
    <NowPlayingPane
      track={track}
      status={status}
      sizeClass={sizeClass}
      isPlaying={isPlaying}
      isBackground={isBackground}
      localPaused={localPaused}
      progress={progress}
      audioDuration={audioDuration}
      badgeLabel={badgeLabel}
      reactionState={reactionState}
      onTogglePlayPause={onTogglePlayPause}
      onSeekBackward={onSeekBackward}
      onSeekForward={onSeekForward}
      onReact={onReact}
    />
  );

  const liveRail = (railStyle?: object) => (
    <LiveRailPane
      status={status}
      statusMessage={statusMessage}
      listenerCount={listenerCount}
      track={track}
      activityLog={activityLog}
      effectiveDjLocked={effectiveDjLocked}
      djCountdown={djCountdown}
      errorMessage={errorMessage}
      sizeClass={sizeClass}
      onClaimDj={onClaimDj}
      style={railStyle}
    />
  );

  const pill = (
    <StatusPill status={status} message={statusMessage} listenerCount={listenerCount} bottomInset={insets.bottom} />
  );

  // ---- Regular + landscape → two-pane (hero | glass rail) ----
  if (sizeClass === 'regular' && isLandscape) {
    return (
      <View style={styles.root}>
        <View
          style={[
            styles.landscapeRow,
            { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + spacing.x3,
              paddingLeft: insets.left + spacing.x2, paddingRight: insets.right + spacing.x2 },
          ]}
        >
          <ScrollView style={styles.heroFlex} contentContainerStyle={styles.heroCentered}>
            {nowPlaying}
          </ScrollView>
          {liveRail(styles.railFixed)}
        </View>
        {pill}
      </View>
    );
  }

  // ---- Regular + portrait → centered max-width single column ----
  if (sizeClass === 'regular') {
    return (
      <View style={styles.root}>
        <ScrollView
          contentContainerStyle={[
            styles.portraitContent,
            { paddingTop: insets.top + spacing.x2, paddingBottom: insets.bottom + 96 },
          ]}
        >
          <View style={[styles.column, { maxWidth: contentMaxWidth }]}>
            {nowPlaying}
            {liveRail(styles.railFull)}
            <Text style={styles.footer}>PRESENTED BY GENERATIVE RADIO</Text>
          </View>
        </ScrollView>
        {pill}
      </View>
    );
  }

  // ---- Compact (phone) → restyled single column ----
  return (
    <View style={styles.root}>
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.compactContent,
          { paddingTop: insets.top + spacing.lg, paddingBottom: insets.bottom + 88 },
        ]}
      >
        {!readonly && onChangeGenre && (
          <TouchableOpacity onPress={onChangeGenre} style={styles.topBar}>
            <Text style={styles.backBtn}>← Change Genres</Text>
          </TouchableOpacity>
        )}
        {nowPlaying}
        {liveRail(styles.railFull)}
        <Text style={styles.footer}>PRESENTED BY GENERATIVE RADIO</Text>
      </ScrollView>
      {pill}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },

  // Landscape two-pane
  landscapeRow: { flex: 1, flexDirection: 'row', gap: spacing.x2 },
  heroFlex: { flex: 1.6 },
  heroCentered: { flexGrow: 1, justifyContent: 'center', alignItems: 'center', paddingVertical: spacing.lg },
  railFixed: { width: 340, alignSelf: 'stretch' },

  // Regular portrait
  portraitContent: { paddingHorizontal: spacing.xl, alignItems: 'center' },
  column: { width: '100%', alignSelf: 'center', gap: spacing.xl },
  railFull: { width: '100%' },

  // Compact
  compactContent: { paddingHorizontal: spacing.lg, gap: spacing.xl },
  topBar: { marginBottom: spacing.xs },
  backBtn: { color: colors.textDim, fontSize: 14 },

  footer: { textAlign: 'center', color: colors.textMuted, fontSize: 10, letterSpacing: 1, marginTop: spacing.lg, textTransform: 'uppercase' },
});
