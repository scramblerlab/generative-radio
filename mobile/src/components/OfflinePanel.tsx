import React, { useState, useEffect, useMemo, useRef } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, Modal, ActivityIndicator,
} from 'react-native';
import { Genre } from '@radio/shared';
import { BACKEND_URL } from '../config';
import { colors, fonts, radius } from './theme';
import {
  OfflineTrackMeta,
  DownloadProgress,
  fetchLibraryIndex,
  filterTracks,
  sampleTracks,
  scanOfflineTracks,
  downloadTracks,
  cacheGenres,
  loadCachedGenres,
} from '../utils/offlineLibrary';

const DEFAULT_MAX_TRACKS = 500;
const MAX_TRACKS_CAP = 500;

interface Props {
  visible: boolean;
  onClose: () => void;
  onStartOffline: (tracks: OfflineTrackMeta[]) => void;
}

type Phase = 'setup' | 'downloading';

export function OfflinePanel({ visible, onClose, onStartOffline }: Props) {
  const [phase, setPhase] = useState<Phase>('setup');
  const [maxTracksText, setMaxTracksText] = useState(String(DEFAULT_MAX_TRACKS));
  const [keyword, setKeyword] = useState('');
  const [genreId, setGenreId] = useState('');
  const [index, setIndex] = useState<OfflineTrackMeta[] | null>(null);
  const [indexError, setIndexError] = useState<string | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [existingCount, setExistingCount] = useState(0);
  const [progress, setProgress] = useState<DownloadProgress>({ done: 0, total: 0, failed: 0 });
  const [cancelling, setCancelling] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    setPhase('setup');
    setIndexError(null);
    setCancelling(false);
    setExistingCount(scanOfflineTracks().length);

    fetchLibraryIndex()
      .then((r) => setIndex(r.tracks))
      .catch(() => {
        setIndex([]);
        setIndexError('Library unavailable — check connection');
      });

    fetch(`${BACKEND_URL}/api/genres`)
      .then((r) => r.json())
      .then((data: { genres: Genre[] }) => {
        setGenres(data.genres);
        cacheGenres(data.genres);
      })
      .catch(() => {
        setGenres(loadCachedGenres() ?? []);
      });
  }, [visible]);

  const maxTracks = useMemo(() => {
    if (maxTracksText.trim() === '') return DEFAULT_MAX_TRACKS;
    const n = parseInt(maxTracksText, 10);
    if (!Number.isFinite(n) || n < 1) return 1;
    return Math.min(n, MAX_TRACKS_CAP);
  }, [maxTracksText]);

  const found = useMemo(
    () => (index ? filterTracks(index, keyword, genreId).length : 0),
    [index, keyword, genreId]
  );

  const handleMaxTracksBlur = () => {
    setMaxTracksText(String(maxTracks));
  };

  const handleDownload = async () => {
    if (!index) return;
    const filtered = filterTracks(index, keyword, genreId);
    const selected = filtered.length > maxTracks ? sampleTracks(filtered, maxTracks) : filtered;
    cancelRef.current = false;
    setCancelling(false);
    setPhase('downloading');
    setProgress({ done: 0, total: selected.length, failed: 0 });
    try {
      const result = await downloadTracks(selected, setProgress, () => cancelRef.current);
      if (result.cancelled) {
        // Partial set kept on disk — playable via PLAY EXISTING TRACKS.
        setExistingCount(scanOfflineTracks().length);
        setPhase('setup');
        return;
      }
      if (result.downloaded.length === 0) {
        setPhase('setup');
        setIndexError('Download failed — no tracks saved');
        return;
      }
      onStartOffline(result.downloaded);
      setPhase('setup');
      onClose();
    } catch (err) {
      setPhase('setup');
      setIndexError(String((err as Error).message));
    }
  };

  const handlePlayExisting = () => {
    const tracks = scanOfflineTracks();
    if (tracks.length === 0) return;
    onStartOffline(tracks);
    onClose();
  };

  const handleCancelDownload = () => {
    cancelRef.current = true;
    setCancelling(true);
  };

  const handleRequestClose = () => {
    if (phase === 'downloading') {
      handleCancelDownload();
      return;
    }
    onClose();
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={handleRequestClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>OFFLINE MODE</Text>
          <Text style={styles.subtitle}>Download tracks to play without a connection</Text>
        </View>

        {phase === 'setup' ? (
          <>
            <ScrollView contentContainerStyle={styles.content}>
              <Text style={styles.sectionLabel}>Max tracks to download</Text>
              <TextInput
                style={styles.textInput}
                value={maxTracksText}
                onChangeText={(t) => setMaxTracksText(t.replace(/[^0-9]/g, ''))}
                onBlur={handleMaxTracksBlur}
                keyboardType="number-pad"
                placeholder={String(DEFAULT_MAX_TRACKS)}
                placeholderTextColor={colors.border2}
              />

              <Text style={styles.sectionLabel}>
                Keyword <Text style={styles.optional}>(matches track tags, optional)</Text>
              </Text>
              <TextInput
                style={styles.textInput}
                value={keyword}
                onChangeText={setKeyword}
                placeholder="e.g. saxophone"
                placeholderTextColor={colors.border2}
              />

              <Text style={styles.sectionLabel}>Genre</Text>
              <View style={styles.pillGrid}>
                <TouchableOpacity
                  style={[styles.pill, genreId === '' && styles.pillActive]}
                  onPress={() => setGenreId('')}
                >
                  <Text style={[styles.pillText, genreId === '' && styles.pillTextActive]}>All</Text>
                </TouchableOpacity>
                {genres.map((g) => (
                  <TouchableOpacity
                    key={g.id}
                    style={[styles.pill, genreId === g.id && styles.pillActive]}
                    onPress={() => setGenreId(g.id)}
                  >
                    <Text style={[styles.pillText, genreId === g.id && styles.pillTextActive]}>{g.label}</Text>
                  </TouchableOpacity>
                ))}
              </View>

              {index === null ? (
                <Text style={styles.foundTextMuted}>Loading library…</Text>
              ) : indexError ? (
                <Text style={styles.foundTextMuted}>{indexError}</Text>
              ) : (
                <Text style={styles.foundText}>Found {found} tracks</Text>
              )}
            </ScrollView>

            <View style={styles.footer}>
              <TouchableOpacity
                style={[styles.submitBtn, (found === 0 || !index) && styles.submitBtnDisabled]}
                onPress={handleDownload}
                disabled={found === 0 || !index}
              >
                <Text style={styles.submitBtnText}>DOWNLOAD</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.outlineBtn, existingCount === 0 && styles.outlineBtnDisabled]}
                onPress={handlePlayExisting}
                disabled={existingCount === 0}
              >
                <Text style={styles.outlineBtnText}>
                  PLAY EXISTING TRACKS ({existingCount})
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
                <Text style={styles.cancelBtnText}>Cancel</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : (
          <>
            <View style={styles.loadingContainer}>
              <ActivityIndicator color={colors.accent} />
              <Text style={styles.standByText}>STAND BY...</Text>
              <Text style={styles.subtitle}>
                {progress.done} / {progress.total} tracks downloaded
                {progress.failed > 0 ? ` · ${progress.failed} failed` : ''}
              </Text>
              <View style={styles.progressBar}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0}%` },
                  ]}
                />
              </View>
            </View>
            <View style={styles.footer}>
              <TouchableOpacity style={styles.cancelBtn} onPress={handleCancelDownload} disabled={cancelling}>
                <Text style={styles.cancelBtnText}>{cancelling ? 'Cancelling…' : 'Cancel'}</Text>
              </TouchableOpacity>
            </View>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },

  header: { alignItems: 'center', padding: 20, paddingTop: 60, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontFamily: fonts.display, fontSize: 32, color: colors.text, letterSpacing: 1 },
  subtitle: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted, marginTop: 6, textAlign: 'center', letterSpacing: 0.3 },

  content: { padding: 20, paddingBottom: 20 },
  sectionLabel: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10, marginTop: 20 },
  optional: { fontFamily: fonts.regular, color: colors.border2, textTransform: 'none', letterSpacing: 0 },

  textInput: { fontFamily: fonts.regular, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 12, color: colors.text, fontSize: 14 },

  pillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  pill: { paddingHorizontal: 18, paddingVertical: 9, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  pillActive: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  pillText: { fontFamily: fonts.semiBold, color: colors.textDim, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 },
  pillTextActive: { color: colors.text },

  foundText: { fontFamily: fonts.semiBold, color: colors.accent, fontSize: 14, marginTop: 20 },
  foundTextMuted: { fontFamily: fonts.regular, color: colors.textMuted, fontSize: 13, marginTop: 20 },

  footer: { padding: 20, paddingBottom: 40, borderTopWidth: 1, borderTopColor: colors.border, gap: 12 },
  submitBtn: { paddingVertical: 14, borderRadius: radius.sm, backgroundColor: colors.accent, alignItems: 'center' },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { fontFamily: fonts.bold, color: '#000', fontSize: 15, letterSpacing: 0.5 },

  outlineBtn: { paddingVertical: 14, borderRadius: radius.sm, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border2, alignItems: 'center' },
  outlineBtnDisabled: { opacity: 0.5 },
  outlineBtnText: { fontFamily: fonts.bold, color: colors.textMuted, fontSize: 15, letterSpacing: 0.5 },

  cancelBtn: { alignItems: 'center', paddingVertical: 4 },
  cancelBtnText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },

  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, gap: 8 },
  standByText: { fontFamily: fonts.display, fontSize: 28, color: colors.text, letterSpacing: 1, marginTop: 8 },

  progressBar: { height: 2, width: '100%', backgroundColor: colors.surface2, marginTop: 20 },
  progressFill: { height: 2, backgroundColor: colors.accent },
});
