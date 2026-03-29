import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity,
  StyleSheet, Animated, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { MaterialIcons } from '@expo/vector-icons';
import { Track, RadioStatus, ActivityEntry, ReactionState } from '@radio/shared';
import { colors, radius } from './theme';

// ------------------------------------------------------------------ //
// Sub-components
// ------------------------------------------------------------------ //

function Waveform({ active }: { active: boolean }) {
  const heights = [0.35, 0.65, 1.0, 0.55, 0.8];
  const anims = useRef(heights.map(() => new Animated.Value(0.25))).current;

  useEffect(() => {
    if (!active) {
      anims.forEach((a) =>
        Animated.spring(a, { toValue: 0.25, useNativeDriver: false }).start()
      );
      return;
    }
    const loops = anims.map((anim, i) =>
      Animated.loop(
        Animated.sequence([
          Animated.timing(anim, {
            toValue: heights[i],
            duration: 350 + i * 90,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
          Animated.timing(anim, {
            toValue: 0.15,
            duration: 350 + i * 90,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: false,
          }),
        ])
      )
    );
    loops.forEach((l) => l.start());
    return () => loops.forEach((l) => l.stop());
  }, [active]);

  return (
    <View style={waveStyles.container}>
      {anims.map((anim, i) => (
        <Animated.View
          key={i}
          style={[
            waveStyles.bar,
            {
              height: anim.interpolate({ inputRange: [0, 1], outputRange: [3, 28] }),
              opacity: active ? 1 : 0.3,
            },
          ]}
        />
      ))}
    </View>
  );
}

const waveStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4, height: 32, marginBottom: 14 },
  bar: { width: 3, borderRadius: 2, backgroundColor: colors.accent },
});

function ActivityLog({ entries }: { entries: ActivityEntry[] }) {
  const scrollRef = useRef<ScrollView>(null);
  useEffect(() => {
    scrollRef.current?.scrollToEnd({ animated: true });
  }, [entries.length]);

  if (entries.length === 0) return null;

  return (
    <ScrollView
      ref={scrollRef}
      horizontal
      showsHorizontalScrollIndicator={false}
      style={logStyles.scroll}
      contentContainerStyle={logStyles.content}
    >
      <Text style={logStyles.text}>
        {entries.map((e, i) => `${i > 0 ? ' · ' : ''}${e.message}`).join('')}
      </Text>
    </ScrollView>
  );
}

const logStyles = StyleSheet.create({
  scroll: { marginTop: 12 },
  content: { paddingVertical: 2 },
  text: { color: colors.textMuted, fontSize: 11, letterSpacing: 0.3 },
});

function BottomStatusBar({
  status, message, nextReady, listenerCount,
}: {
  status: RadioStatus; message: string; nextReady: boolean; listenerCount: number;
}) {
  // Match web StatusBar logic exactly:
  // green when playing + next track already buffered; amber (pulsing) otherwise active
  const dotColor =
    status === 'playing' && nextReady ? colors.green : colors.accent;
  const dimmed = status === 'idle' || status === 'stopped' || status === 'connecting';

  const label =
    message ||
    (status === 'generating' ? 'Generating your first track...' :
     status === 'buffering'  ? 'Buffering next track...' :
     status === 'playing' && nextReady ? 'Playing — next track ready' :
     status === 'playing'    ? 'Playing — generating next track...' :
     status === 'connecting' ? 'Connecting...' : '');

  return (
    <View style={sbStyles.bar}>
      <View style={sbStyles.left}>
        <View style={[sbStyles.dot, { backgroundColor: dimmed ? colors.textMuted : dotColor }]} />
        <Text style={sbStyles.label} numberOfLines={1}>{label}</Text>
      </View>
      {listenerCount > 0 && (
        <View style={sbStyles.countBadge}>
          <MaterialIcons name="people" size={12} color={colors.textMuted} />
          <Text style={sbStyles.countText}>{listenerCount}</Text>
        </View>
      )}
    </View>
  );
}

const sbStyles = StyleSheet.create({
  bar: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 10,
    borderTopWidth: 1, borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  left: { flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  label: { color: colors.textDim, fontSize: 12, flex: 1 },
  countBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border2 },
  countText: { color: colors.textMuted, fontSize: 11 },
});

// ------------------------------------------------------------------ //
// Main RadioPlayer
// ------------------------------------------------------------------ //

interface Props {
  readonly: boolean;
  track: Track | null;
  status: RadioStatus;
  nextReady: boolean;
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
  readonly, track, status, nextReady, statusMessage, errorMessage,
  activityLog, progress, audioDuration, listenerCount, localPaused,
  djLocked, djUnlockAt, activeDjName, reactionState,
  onTogglePlayPause, onSeekBackward, onSeekForward,
  onChangeGenre, onClaimDj, onReact,
}: Props) {
  const insets = useSafeAreaInsets();
  const isPlaying = status === 'playing' && !localPaused;

  // Derive effective DJ locked state from timestamp (matches web logic)
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  const nowSec = Date.now() / 1000;
  const remainingSec = djUnlockAt > 0 ? Math.max(0, Math.ceil(djUnlockAt - nowSec)) : Infinity;
  const effectiveDjLocked = remainingSec > 0;
  const djCountdown =
    effectiveDjLocked && remainingSec !== Infinity
      ? `${Math.floor(remainingSec / 60)}:${String(remainingSec % 60).padStart(2, '0')}`
      : '';

  // Controller badge label (matches web)
  const badgeLabel = track
    ? [
        !readonly ? 'CONTROLLER' : null,
        track.isRandom
          ? track.genre ? `RANDOM · ${track.genre.toUpperCase()}` : 'RANDOM'
          : track.genre.toUpperCase(),
        track.djName ? `(DJ: ${track.djName})` : null,
      ].filter(Boolean).join(' · ')
    : null;

  return (
    <View style={styles.root}>
      {/* Scrollable main content */}
      <ScrollView style={styles.scroll} contentContainerStyle={[styles.content, { paddingTop: insets.top + 16 }]}>
        {/* Top bar */}
        {!readonly && onChangeGenre && (
          <View style={styles.topBar}>
            <TouchableOpacity onPress={onChangeGenre}>
              <Text style={styles.backBtn}>← Change Genres</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Card */}
        <View style={styles.card}>
          {/* Genre / controller badge */}
          {badgeLabel && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{badgeLabel}</Text>
            </View>
          )}

          {/* Now playing */}
          <Waveform active={isPlaying} />

          {track ? (
            <>
              <Text style={styles.songTitle}>{track.songTitle}</Text>
              {track.tags ? (
                <Text style={styles.tags}>{track.tags}</Text>
              ) : null}
              <Text style={styles.meta}>
                {[
                  track.bpm ? `${track.bpm} BPM` : null,
                  track.keyScale || null,
                  audioDuration ? `${audioDuration}s` : track.duration ? `${track.duration}s` : null,
                ].filter(Boolean).join(' · ')}
              </Text>
              {track.lyrics ? (
                <ScrollView style={styles.lyricsScroll} nestedScrollEnabled>
                  <Text style={styles.lyricsText}>{track.lyrics}</Text>
                </ScrollView>
              ) : null}
            </>
          ) : (
            <>
              <Text style={styles.songTitle}>
                {status === 'generating' ? 'Generating...' :
                 status === 'buffering' ? 'Loading next track...' :
                 status === 'connecting' ? 'Connecting...' :
                 readonly ? 'Waiting for host...' : 'Ready'}
              </Text>
              <Text style={styles.tags}>
                {status === 'generating' ? 'Your first track is on its way' :
                 status === 'buffering' ? 'Almost there...' :
                 readonly ? 'The host will start the radio soon' : 'Select genres to begin'}
              </Text>
            </>
          )}

          {/* Progress bar */}
          <View style={styles.progressBar}>
            <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
          </View>

          {/* Transport controls */}
          {track && (
            <View style={styles.controls}>
              <TouchableOpacity style={styles.iconBtn} onPress={onSeekBackward}>
                <MaterialIcons name="replay-10" size={28} color={colors.textDim} />
              </TouchableOpacity>
              <TouchableOpacity style={styles.playBtn} onPress={onTogglePlayPause}>
                <MaterialIcons
                  name={localPaused ? 'play-arrow' : 'pause'}
                  size={32}
                  color="#000"
                />
              </TouchableOpacity>
              <TouchableOpacity style={styles.iconBtn} onPress={onSeekForward}>
                <MaterialIcons name="forward-10" size={28} color={colors.textDim} />
              </TouchableOpacity>
            </View>
          )}

          {/* Reactions */}
          {track && onReact && (
            <View style={styles.reactions}>
              <TouchableOpacity
                style={[styles.reactionBtn, reactionState.userReaction === 'thumb_up' && styles.reactionBtnActive]}
                onPress={() => onReact(track.id, 'thumb_up')}
              >
                <MaterialIcons
                  name="thumb-up"
                  size={16}
                  color={reactionState.userReaction === 'thumb_up' ? colors.accent : colors.textDim}
                />
                <Text style={[styles.reactionCount, reactionState.userReaction === 'thumb_up' && styles.reactionCountActive]}>
                  {reactionState.thumbUp}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.reactionBtn, reactionState.userReaction === 'thumb_down' && styles.reactionBtnActive]}
                onPress={() => onReact(track.id, 'thumb_down')}
              >
                <MaterialIcons
                  name="thumb-down"
                  size={16}
                  color={reactionState.userReaction === 'thumb_down' ? colors.accent : colors.textDim}
                />
                <Text style={[styles.reactionCount, reactionState.userReaction === 'thumb_down' && styles.reactionCountActive]}>
                  {reactionState.thumbDown}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Activity log (horizontal scroll) */}
          <ActivityLog entries={activityLog} />

          {/* Error */}
          {errorMessage && (
            <View style={styles.errorBox}>
              <Text style={styles.errorText}>⚠ {errorMessage}</Text>
            </View>
          )}

          {/* DJ info row (visible when a DJ session is active) */}
          {track?.djName && (
            <View style={styles.djInfoRow}>
              <Text style={styles.djInfoText}>
                {[
                  track.djName,
                  track.genre
                    ? (track.isRandom ? `Random · ${track.genre}` : track.genre)
                    : null,
                  track.djKeywords.length > 0 ? track.djKeywords.join(' · ') : null,
                  track.djLanguage
                    ? (track.djLanguage === 'instrumental' ? 'Instrumental' : track.djLanguage.toUpperCase())
                    : null,
                ].filter(Boolean).join('  ·  ')}
              </Text>
            </View>
          )}

          {/* DJ section — Generate Your Tracks button */}
          {onClaimDj && (
            <View style={styles.djSection}>
              <TouchableOpacity
                style={[styles.djBtn, effectiveDjLocked && styles.djBtnLocked]}
                onPress={effectiveDjLocked ? undefined : onClaimDj}
                disabled={effectiveDjLocked}
              >
                <Text style={[styles.djBtnText, effectiveDjLocked && styles.djBtnTextLocked]}>
                  Generate Your Tracks
                </Text>
              </TouchableOpacity>
              {effectiveDjLocked && djCountdown ? (
                <Text style={styles.djCountdown}>Unlocks in {djCountdown}</Text>
              ) : null}
            </View>
          )}
        </View>

        <Text style={styles.footer}>PRESENTED BY GENERATIVE RADIO</Text>
      </ScrollView>

      {/* Bottom status bar */}
      <BottomStatusBar
        status={status}
        message={statusMessage}
        nextReady={nextReady}
        listenerCount={listenerCount}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  scroll: { flex: 1 },
  content: { padding: 16, paddingBottom: 40 },

  topBar: { marginBottom: 12 },
  backBtn: { color: colors.textDim, fontSize: 14 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: 20,
    borderWidth: 1,
    borderColor: colors.border,
  },

  // Badge
  badge: {
    alignSelf: 'flex-start',
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 4,
    marginBottom: 16,
  },
  badgeText: { color: colors.accent, fontSize: 11, fontWeight: '600', letterSpacing: 0.5 },

  // Track info
  songTitle: { fontSize: 24, fontWeight: '700', color: colors.text, marginBottom: 6, textAlign: 'center' },
  tags: { fontSize: 13, color: colors.textDim, marginBottom: 6, lineHeight: 18, textAlign: 'center' },
  meta: { fontSize: 11, color: colors.textMuted, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: 10, textAlign: 'center' },

  // Lyrics
  lyricsScroll: { maxHeight: 100, marginTop: 8, marginBottom: 4 },
  lyricsText: { color: colors.textMuted, fontSize: 12, lineHeight: 18 },

  // Progress
  progressBar: { height: 2, backgroundColor: colors.surface2, marginVertical: 16 },
  progressFill: { height: 2, backgroundColor: colors.accent },

  // Controls
  controls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 28, marginBottom: 16 },
  iconBtn: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface2, justifyContent: 'center', alignItems: 'center' },
  playBtn: { width: 56, height: 56, borderRadius: 28, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },

  // Reactions
  reactions: { flexDirection: 'row', gap: 8, marginBottom: 4, justifyContent: 'center' },
  reactionBtn: {
    flexDirection: 'row', alignItems: 'center', gap: 6,
    paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border2,
    backgroundColor: colors.surface2,
  },
  reactionBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  reactionCount: { color: colors.textDim, fontSize: 13 },
  reactionCountActive: { color: colors.accent },

  // Error
  errorBox: { marginTop: 12, padding: 12, backgroundColor: 'rgba(239,68,68,0.1)', borderRadius: radius.sm, borderWidth: 1, borderColor: colors.red },
  errorText: { color: colors.red, fontSize: 13 },

  // DJ info
  djInfoRow: { marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderTopColor: colors.border },
  djInfoText: { color: colors.textMuted, fontSize: 12 },

  // DJ button
  djSection: { marginTop: 14 },
  djBtn: { paddingVertical: 14, borderRadius: radius.sm, backgroundColor: colors.accent, alignItems: 'center' },
  djBtnLocked: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border2 },
  djBtnText: { color: '#000', fontSize: 14, fontWeight: '700', letterSpacing: 0.5, textTransform: 'uppercase' },
  djBtnTextLocked: { color: colors.textMuted },
  djCountdown: { textAlign: 'center', color: colors.textMuted, fontSize: 12, marginTop: 6 },

  footer: { textAlign: 'center', color: colors.textMuted, fontSize: 10, letterSpacing: 1, marginTop: 24, textTransform: 'uppercase' },
});
