import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, Modal, ActivityIndicator,
} from 'react-native';
import { Genre, Keyword, Language } from '@radio/shared';
import { BACKEND_URL } from '../config';
import { colors, radius } from './theme';

const MOOD_CATEGORY_ORDER = ['emotion', 'atmosphere', 'instrument'];
const MOOD_CATEGORY_LABELS: Record<string, string> = {
  emotion: 'Emotion',
  atmosphere: 'Atmosphere',
  instrument: 'Instrument',
};

interface Props {
  visible: boolean;
  onSubmit: (genres: string[], keywords: string[], language: string, feeling: string, djName: string) => void;
  onClose: () => void;
}

export function DJPanel({ visible, onSubmit, onClose }: Props) {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<string>('rock');
  const [isRandomGenre, setIsRandomGenre] = useState(false);
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [randomCategories, setRandomCategories] = useState<Set<string>>(new Set());
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  const [feeling, setFeeling] = useState('');
  const [djName, setDjName] = useState('');
  const [djNameError, setDjNameError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!visible) return;
    fetch(`${BACKEND_URL}/api/genres`)
      .then((r) => r.json())
      .then((data: { genres: Genre[]; keywords: Keyword[]; languages: Language[] }) => {
        setGenres(data.genres);
        setKeywords(data.keywords);
        setLanguages(data.languages);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [visible]);

  const keywordsByCategory = useMemo(() => {
    const map: Record<string, Keyword[]> = {};
    for (const kw of keywords) {
      if (!map[kw.category]) map[kw.category] = [];
      map[kw.category].push(kw);
    }
    return map;
  }, [keywords]);

  const handleSubmit = () => {
    const name = djName.trim();
    if (!name) { setDjNameError('DJ name is required'); return; }
    const genreArg = isRandomGenre ? ['__random__'] : [selectedGenre];
    const kwList = [...selectedKeywords];
    for (const cat of randomCategories) {
      const catKws = keywordsByCategory[cat] ?? [];
      if (catKws.length > 0) {
        const rand = catKws[Math.floor(Math.random() * catKws.length)];
        kwList.push(rand.id);
      }
    }
    onSubmit(genreArg, kwList, selectedLanguage, feeling, name);
  };

  const toggleKeyword = (id: string) => {
    setSelectedKeywords((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <View>
            <Text style={styles.title}>You're the DJ!</Text>
            <Text style={styles.subtitle}>Shape the next track for everyone</Text>
          </View>
          <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
            <Text style={styles.closeBtnText}>✕</Text>
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView contentContainerStyle={styles.content}>
            {/* Genre */}
            <Text style={styles.sectionLabel}>Genre</Text>
            <View style={styles.pillGrid}>
              <TouchableOpacity
                style={[styles.pill, isRandomGenre && styles.pillActive]}
                onPress={() => setIsRandomGenre(true)}
              >
                <Text style={[styles.pillText, isRandomGenre && styles.pillTextActive]}>🎲 Random</Text>
              </TouchableOpacity>
              {genres.map((g) => (
                <TouchableOpacity
                  key={g.id}
                  style={[styles.pill, !isRandomGenre && selectedGenre === g.id && styles.pillActive]}
                  onPress={() => { setSelectedGenre(g.id); setIsRandomGenre(false); }}
                >
                  <Text style={[styles.pillText, !isRandomGenre && selectedGenre === g.id && styles.pillTextActive]}>
                    {g.icon} {g.label}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Keywords */}
            <Text style={styles.sectionLabel}>Mood <Text style={styles.optional}>(optional)</Text></Text>
            {MOOD_CATEGORY_ORDER.filter((c) => keywordsByCategory[c]?.length).map((cat) => (
              <View key={cat} style={styles.kwCategory}>
                <View style={styles.kwCategoryHeader}>
                  <Text style={styles.kwCategoryLabel}>{MOOD_CATEGORY_LABELS[cat]}</Text>
                  <TouchableOpacity
                    style={[styles.randBtn, randomCategories.has(cat) && styles.randBtnActive]}
                    onPress={() => setRandomCategories((prev) => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n; })}
                  >
                    <Text style={[styles.randBtnText, randomCategories.has(cat) && styles.randBtnTextActive]}>🎲 Surprise</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.pillGrid}>
                  {keywordsByCategory[cat].map((kw) => (
                    <TouchableOpacity
                      key={kw.id}
                      style={[styles.pill, selectedKeywords.has(kw.id) && styles.pillActive]}
                      onPress={() => toggleKeyword(kw.id)}
                    >
                      <Text style={[styles.pillText, selectedKeywords.has(kw.id) && styles.pillTextActive]}>{kw.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}

            {/* Language */}
            <Text style={styles.sectionLabel}>Language</Text>
            <View style={styles.pillGrid}>
              {languages.map((l) => (
                <TouchableOpacity
                  key={l.code}
                  style={[styles.pill, selectedLanguage === l.code && styles.pillActive]}
                  onPress={() => setSelectedLanguage(l.code)}
                >
                  <Text style={[styles.pillText, selectedLanguage === l.code && styles.pillTextActive]}>{l.label}</Text>
                </TouchableOpacity>
              ))}
            </View>

            {/* Context */}
            <Text style={styles.sectionLabel}>Context <Text style={styles.optional}>(optional)</Text></Text>
            <TextInput
              style={styles.textInput}
              value={feeling}
              onChangeText={setFeeling}
              placeholder="Set the mood…"
              placeholderTextColor={colors.textMuted}
              maxLength={200}
              multiline
            />

            {/* DJ Name */}
            <Text style={styles.sectionLabel}>Your DJ Name</Text>
            <TextInput
              style={[styles.textInput, djNameError ? styles.inputError : null]}
              value={djName}
              onChangeText={(t) => { setDjName(t); setDjNameError(''); }}
              placeholder="Enter your DJ name…"
              placeholderTextColor={colors.textMuted}
              maxLength={50}
            />
            {djNameError ? <Text style={styles.errorText}>{djNameError}</Text> : null}
          </ScrollView>
        )}

        <View style={styles.footer}>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.submitBtn} onPress={handleSubmit}>
            <Text style={styles.submitBtnText}>Take the Stage 🎤</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', padding: 20, paddingTop: 60, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 24, fontWeight: '700', color: colors.text },
  subtitle: { color: colors.textDim, fontSize: 14, marginTop: 4 },
  closeBtn: { padding: 8 },
  closeBtnText: { color: colors.textMuted, fontSize: 18 },
  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: 20, paddingBottom: 20 },
  sectionLabel: { fontSize: 13, fontWeight: '600', color: colors.textDim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10, marginTop: 20 },
  optional: { fontWeight: '400', color: colors.textMuted },
  pillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border2, backgroundColor: colors.surface },
  pillActive: { borderColor: colors.accent, backgroundColor: colors.accentDim },
  pillText: { color: colors.textDim, fontSize: 13 },
  pillTextActive: { color: colors.accent },
  kwCategory: { marginBottom: 16 },
  kwCategoryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  kwCategoryLabel: { fontSize: 12, color: colors.textMuted, textTransform: 'uppercase' },
  randBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  randBtnActive: { borderColor: colors.indigo, backgroundColor: 'rgba(99,102,241,0.12)' },
  randBtnText: { color: colors.textMuted, fontSize: 11 },
  randBtnTextActive: { color: colors.indigo },
  textInput: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 12, color: colors.text, fontSize: 14 },
  inputError: { borderColor: colors.red },
  errorText: { color: colors.red, fontSize: 12, marginTop: 4 },
  footer: { flexDirection: 'row', gap: 12, padding: 20, borderTopWidth: 1, borderTopColor: colors.border, paddingBottom: 40 },
  cancelBtn: { flex: 1, paddingVertical: 14, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border2, alignItems: 'center' },
  cancelBtnText: { color: colors.textDim, fontSize: 15 },
  submitBtn: { flex: 2, paddingVertical: 14, borderRadius: radius.sm, backgroundColor: colors.accent, alignItems: 'center' },
  submitBtnText: { color: '#000', fontSize: 15, fontWeight: '700' },
});
