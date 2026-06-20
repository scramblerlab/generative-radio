import React from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet } from 'react-native';
import { MaterialIcons } from '@expo/vector-icons';
import { Track, RadioStatus, ReactionState } from '@radio/shared';
import { colors, fonts, radius, spacing, type as typeScale } from './theme';
import type { SizeClass } from './theme';
import { GenerativeVisual } from './GenerativeVisual';

function fmtTime(totalSec: number): string {
  if (!totalSec || totalSec < 0) return '0:00';
  const m = Math.floor(totalSec / 60);
  const s = Math.floor(totalSec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

interface Props {
  track: Track | null;
  status: RadioStatus;
  sizeClass: SizeClass;
  isPlaying: boolean;
  isBackground: boolean;
  localPaused: boolean;
  progress: number;
  audioDuration: number | null;
  badgeLabel: string | null;
  reactionState: ReactionState;
  onTogglePlayPause: () => void;
  onSeekBackward: () => void;
  onSeekForward: () => void;
  onReact?: (trackId: string, action: 'thumb_up' | 'thumb_down') => void;
}

export function NowPlayingPane({
  track, status, sizeClass, isPlaying, isBackground, localPaused,
  progress, audioDuration, badgeLabel, reactionState,
  onTogglePlayPause, onSeekBackward, onSeekForward, onReact,
}: Props) {
  const s = makeStyles(sizeClass);
  const totalSec = audioDuration ?? track?.duration ?? 0;
  const currentSec = totalSec * progress;

  return (
    <View style={s.pane}>
      {badgeLabel && (
        <View style={s.badge}>
          <Text style={s.badgeText}>{badgeLabel}</Text>
        </View>
      )}

      <GenerativeVisual active={isPlaying && !isBackground} sizeClass={sizeClass} />

      {track ? (
        <>
          <Text style={s.songTitle}>{track.songTitle}</Text>
          {track.tags ? <Text style={s.tags}>{track.tags}</Text> : null}
          <Text style={s.meta}>
            {[
              track.bpm ? `${track.bpm} BPM` : null,
              track.keyScale || null,
              audioDuration ? `${audioDuration}s` : track.duration ? `${track.duration}s` : null,
            ].filter(Boolean).join('  ·  ')}
          </Text>
          {track.lyrics ? (
            <ScrollView style={s.lyricsScroll} nestedScrollEnabled>
              <Text style={s.lyricsText}>{track.lyrics}</Text>
            </ScrollView>
          ) : null}
        </>
      ) : (
        <>
          <Text style={s.songTitle}>
            {status === 'generating' ? 'Waiting for radio...' :
             status === 'buffering' ? 'Loading track...' : 'Tuning in...'}
          </Text>
          <Text style={s.tags}>
            {status === 'generating' ? 'The next track is being generated' :
             status === 'buffering' ? 'Almost there...' : 'Connecting to Generative Radio'}
          </Text>
        </>
      )}

      {/* Progress + time readout */}
      <View style={s.progressWrap}>
        <View style={s.progressBar}>
          <View style={[s.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
        </View>
        {track ? (
          <View style={s.timeRow}>
            <Text style={s.timeText}>{fmtTime(currentSec)}</Text>
            <Text style={s.timeText}>{fmtTime(totalSec)}</Text>
          </View>
        ) : null}
      </View>

      {/* Transport */}
      {track && (
        <View style={s.controls}>
          <TouchableOpacity style={s.iconBtn} onPress={onSeekBackward}>
            <MaterialIcons name="replay-10" size={sizeClass === 'regular' ? 34 : 28} color={colors.textDim} />
          </TouchableOpacity>
          <TouchableOpacity style={s.playBtn} onPress={onTogglePlayPause}>
            <MaterialIcons name={localPaused ? 'play-arrow' : 'pause'} size={sizeClass === 'regular' ? 40 : 32} color="#000" />
          </TouchableOpacity>
          <TouchableOpacity style={s.iconBtn} onPress={onSeekForward}>
            <MaterialIcons name="forward-10" size={sizeClass === 'regular' ? 34 : 28} color={colors.textDim} />
          </TouchableOpacity>
        </View>
      )}

      {/* Reactions */}
      {track && onReact && (
        <View style={s.reactions}>
          <TouchableOpacity
            style={[s.reactionBtn, reactionState.userReaction === 'thumb_up' && s.reactionBtnActive]}
            onPress={() => onReact(track.id, 'thumb_up')}
          >
            <MaterialIcons name="thumb-up" size={16} color={reactionState.userReaction === 'thumb_up' ? colors.accent : colors.textDim} />
            <Text style={[s.reactionCount, reactionState.userReaction === 'thumb_up' && s.reactionCountActive]}>
              {reactionState.thumbUp}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[s.reactionBtn, reactionState.userReaction === 'thumb_down' && s.reactionBtnActive]}
            onPress={() => onReact(track.id, 'thumb_down')}
          >
            <MaterialIcons name="thumb-down" size={16} color={reactionState.userReaction === 'thumb_down' ? colors.accent : colors.textDim} />
            <Text style={[s.reactionCount, reactionState.userReaction === 'thumb_down' && s.reactionCountActive]}>
              {reactionState.thumbDown}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function makeStyles(sizeClass: SizeClass) {
  const t = typeScale(sizeClass);
  const regular = sizeClass === 'regular';
  const playSize = regular ? 76 : 56;
  const iconSize = regular ? 60 : 44;
  return StyleSheet.create({
    pane: { alignItems: 'center', width: '100%' },

    badge: {
      alignSelf: 'center',
      borderWidth: 1,
      borderColor: colors.accent,
      borderRadius: radius.pill,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.xs,
      marginBottom: spacing.lg,
    },
    badgeText: { fontFamily: fonts.semiBold, color: colors.accent, fontSize: t.badge, letterSpacing: 0.5 },

    songTitle: {
      fontFamily: fonts.display, fontSize: t.title, letterSpacing: 1.5,
      color: colors.text, marginTop: spacing.lg, marginBottom: spacing.sm, textAlign: 'center',
    },
    tags: { fontFamily: fonts.regular, fontSize: t.tags, color: colors.textMuted, marginBottom: spacing.sm, lineHeight: t.tags * 1.5, textAlign: 'center' },
    meta: { fontFamily: fonts.medium, fontSize: t.meta, color: colors.textDim, letterSpacing: 0.5, textTransform: 'uppercase', marginBottom: spacing.md, textAlign: 'center' },

    lyricsScroll: { maxHeight: regular ? 160 : 100, marginTop: spacing.sm, marginBottom: spacing.xs, alignSelf: 'stretch' },
    lyricsText: { color: colors.textMuted, fontSize: t.lyrics, lineHeight: t.lyrics * 1.5, textAlign: 'center' },

    progressWrap: { alignSelf: 'stretch', marginVertical: spacing.lg, maxWidth: regular ? 560 : undefined, width: regular ? '100%' : undefined, marginHorizontal: 'auto' as const },
    progressBar: { height: 3, backgroundColor: colors.surface2, borderRadius: 2 },
    progressFill: { height: 3, backgroundColor: colors.accent, borderRadius: 2 },
    timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.xs },
    timeText: { fontFamily: fonts.medium, color: colors.textMuted, fontSize: t.label },

    controls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: regular ? 40 : 28, marginBottom: spacing.lg },
    iconBtn: { width: iconSize, height: iconSize, borderRadius: iconSize / 2, backgroundColor: colors.surface2, justifyContent: 'center', alignItems: 'center' },
    playBtn: { width: playSize, height: playSize, borderRadius: playSize / 2, backgroundColor: colors.accent, justifyContent: 'center', alignItems: 'center' },

    reactions: { flexDirection: 'row', gap: spacing.md, justifyContent: 'center' },
    reactionBtn: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
      paddingHorizontal: spacing.lg, paddingVertical: spacing.sm,
      borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border2, backgroundColor: colors.surface2,
    },
    reactionBtnActive: { borderColor: colors.accent, backgroundColor: colors.accentDim },
    reactionCount: { color: colors.textDim, fontSize: t.body },
    reactionCountActive: { color: colors.accent },
  });
}
