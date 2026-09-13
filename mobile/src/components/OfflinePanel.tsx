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
  FETCH_TIMEOUT_MS,
  timeoutSignal,
  LibraryAuthError,
  LibraryDisabledError,
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
  /** Bearer token for the members-only library endpoints. */
  token: string | null;
  /** False while offline mode is playing from the library on disk. DOWNLOAD
   *  replaces that library, so it must not run against the files feeding the
   *  current playback. */
  allowClear: boolean;
}

type Phase = 'setup' | 'downloading';

/** The three ways listing the library can fail have three different fixes, so
 *  they get three different sentences. "Check connection" for a 401 sent the
 *  user to their router when the real answer was "sign in". */
function describeIndexError(err: unknown): string {
  if (err instanceof LibraryAuthError) return 'Sign in to download tracks';
  if (err instanceof LibraryDisabledError) return 'The track library is unavailable on the server';
  if (err instanceof Error && err.name === 'AbortError') return 'The server took too long to respond';
  return 'Library unavailable — check connection';
}

function describeDownloadError(err: unknown): string {
  if (err instanceof LibraryAuthError) return 'Your session expired — sign in again';
  // Disk-space and invariant messages are already written for the user.
  return err instanceof Error ? err.message : 'Download failed';
}

export function OfflinePanel({ visible, onClose, onStartOffline, token, allowClear }: Props) {
  const [phase, setPhase] = useState<Phase>('setup');
  const [maxTracksText, setMaxTracksText] = useState(String(DEFAULT_MAX_TRACKS));
  const [keyword, setKeyword] = useState('');
  const [genreId, setGenreId] = useState('');
  const [index, setIndex] = useState<OfflineTrackMeta[] | null>(null);
  // Two independent failures that used to share one slot. indexError describes
  // the library listing; downloadError describes the last download attempt. With
  // one variable, a stale download failure hid the live "Found N tracks" line.
  const [indexError, setIndexError] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [genres, setGenres] = useState<Genre[]>([]);
  const [existingCount, setExistingCount] = useState(0);
  const [progress, setProgress] = useState<DownloadProgress>({ done: 0, total: 0, failed: 0 });
  const [cancelling, setCancelling] = useState(false);
  const cancelRef = useRef(false);

  useEffect(() => {
    if (!visible) return;
    setPhase('setup');
    setIndexError(null);
    setDownloadError(null);
    setCancelling(false);
    setExistingCount(scanOfflineTracks().length);

    fetchLibraryIndex(token)
      .then((r) => setIndex(r.tracks))
      .catch((err) => {
        setIndex([]);
        setIndexError(describeIndexError(err));
      });

    // Same bound as the index fetch: without it a half-open socket leaves the
    // genre pills missing with no explanation and no cached fallback applied.
    const genresTimeout = timeoutSignal(FETCH_TIMEOUT_MS);
    fetch(`${BACKEND_URL}/api/genres`, { signal: genresTimeout.signal })
      .finally(() => genresTimeout.cancel())
      .then((r) => r.json())
      .then((data: { genres: Genre[] }) => {
        setGenres(data.genres);
        cacheGenres(data.genres);
      })
      .catch(() => {
        setGenres(loadCachedGenres() ?? []);
      });
  }, [visible, token]);

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

  // Changing the selection means the previous failure no longer describes what
  // the button would do, so it stops being shown.
  useEffect(() => { setDownloadError(null); }, [keyword, genreId, maxTracks]);

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
      const result = await downloadTracks(
        selected, setProgress, () => cancelRef.current, token, allowClear,
      );
      if (result.downloaded.length === 0) {
        setDownloadError(result.cancelled
          ? 'Cancelled before any track finished — your existing library is unchanged'
          : 'Download failed — your existing library is unchanged');
        return;
      }
      if (result.cancelled) {
        // A partial set was swapped in; it is playable, but do not tune into it
        // behind the user's back — they asked to stop.
        setDownloadError(`Cancelled — kept the ${result.downloaded.length} tracks that finished`);
        return;
      }
      onStartOffline(result.downloaded);
      onClose();
    } catch (err) {
      setDownloadError(describeDownloadError(err));
    } finally {
      // Every exit path, not just the cancelled one. Otherwise a failed download
      // left "PLAY EXISTING TRACKS (312)" on screen against an empty library and
      // the button silently did nothing.
      setExistingCount(scanOfflineTracks().length);
      setPhase('setup');
    }
  };

  const handlePlayExisting = () => {
    const tracks = scanOfflineTracks();
    if (tracks.length === 0) {
      // Reachable when the on-disk set changed under us. Say so rather than
      // being an unresponsive button.
      setExistingCount(0);
      setDownloadError('No downloaded tracks on this device yet');
      return;
    }
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
              {/* A download failure is about the last attempt, not about the
                  listing, so it never replaces the line above. */}
              {downloadError && <Text style={styles.downloadErrorText}>{downloadError}</Text>}
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
              {existingCount === 0 && (
                <Text style={styles.emptyLibraryText}>No tracks downloaded yet</Text>
              )}
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
  downloadErrorText: { fontFamily: fonts.regular, color: colors.red, fontSize: 13, marginTop: 8 },
  emptyLibraryText: { fontFamily: fonts.regular, color: colors.textMuted, fontSize: 12, textAlign: 'center' },

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
