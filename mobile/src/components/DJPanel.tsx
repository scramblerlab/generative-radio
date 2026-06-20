import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, Modal, ActivityIndicator,
} from 'react-native';
import { Genre, Keyword, Language } from '@radio/shared';
import { BACKEND_URL } from '../config';
import { colors, fonts, radius, spacing } from './theme';
import { useLayout } from '../hooks/useLayout';
import { Glass } from './Glass';

const MOOD_CATEGORY_ORDER = ['emotion', 'atmosphere', 'instrument'];
const MOOD_CATEGORY_LABELS: Record<string, string> = {
  emotion: 'Emotion',
  atmosphere: 'Atmosphere',
  instrument: 'Instrument',
};
const FEELING_MAX_LENGTH = 200;
const DJ_NAME_MAX_LENGTH = 50;

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
  const [nameError, setNameError] = useState(false);
  const [loading, setLoading] = useState(true);
  const { sizeClass } = useLayout();
  const isSheet = sizeClass === 'regular';

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
    const grouped: Record<string, Keyword[]> = {};
    for (const kw of keywords) {
      let cat = kw.category || 'other';
      if (cat === 'energy') cat = 'emotion';
      if (cat === 'texture') cat = 'atmosphere';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(kw);
    }
    return grouped;
  }, [keywords]);

  const selectGenre = (id: string) => {
    setIsRandomGenre(false);
    setSelectedGenre(id);
  };

  const toggleKeyword = (id: string) => {
    const kw = keywords.find((k) => k.id === id);
    if (kw) {
      let cat = kw.category;
      if (cat === 'energy') cat = 'emotion';
      if (cat === 'texture') cat = 'atmosphere';
      setRandomCategories((prev) => {
        if (!prev.has(cat)) return prev;
        const next = new Set(prev);
        next.delete(cat);
        return next;
      });
    }
    setSelectedKeywords((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const randomizeCategory = (cat: string) => {
    setRandomCategories((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
    const items = keywordsByCategory[cat] ?? [];
    if (items.length > 0) {
      setSelectedKeywords((prev) => {
        const next = new Set(prev);
        items.forEach((k) => next.delete(k.id));
        return next;
      });
    }
  };

  const handleSubmit = () => {
    if (!djName.trim()) {
      setNameError(true);
      return;
    }
    const keywordList = [...selectedKeywords];
    randomCategories.forEach((cat) => keywordList.push(`__random_${cat}__`));
    const genreArg = isRandomGenre ? ['__random__'] : [selectedGenre];
    onSubmit(genreArg, keywordList, selectedLanguage, feeling, djName.trim());
  };

  const inner = (
    <>
        {/* Header — centered, no close button (Cancel is in footer) */}
        <View style={[styles.header, isSheet && styles.headerSheet]}>
          <Text style={styles.title}>You're the DJ!</Text>
          <Text style={styles.subtitle}>Pick the vibe — your selections will drive the next tracks for everyone</Text>
        </View>

        {loading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator color={colors.accent} />
          </View>
        ) : (
          <ScrollView style={styles.scrollFlex} contentContainerStyle={styles.content}>

            {/* Genre */}
            <Text style={styles.sectionLabel}>Choose your genre</Text>
            <View style={styles.pillGrid}>
              {genres.map((g) => (
                <TouchableOpacity
                  key={g.id}
                  style={[styles.pill, !isRandomGenre && selectedGenre === g.id && styles.pillActive]}
                  onPress={() => selectGenre(g.id)}
                >
                  <Text style={[styles.pillText, !isRandomGenre && selectedGenre === g.id && styles.pillTextActive]}>
                    {g.label}
                  </Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                style={[styles.pill, styles.pillDashed, isRandomGenre && styles.pillActive]}
                onPress={() => { setIsRandomGenre(true); setSelectedGenre(''); }}
              >
                <Text style={[styles.pillText, isRandomGenre && styles.pillTextActive]}>🎲 Random</Text>
              </TouchableOpacity>
            </View>

            {/* Mood / Keywords */}
            <Text style={styles.sectionLabel}>
              Set the mood <Text style={styles.optional}>(optional)</Text>
            </Text>
            {MOOD_CATEGORY_ORDER.filter((c) => keywordsByCategory[c]?.length).map((cat) => (
              <View key={cat} style={styles.kwCategory}>
                <View style={styles.kwCategoryHeader}>
                  <Text style={styles.kwCategoryLabel}>{MOOD_CATEGORY_LABELS[cat]}</Text>
                  <TouchableOpacity
                    style={[styles.randBtn, randomCategories.has(cat) && styles.randBtnActive]}
                    onPress={() => randomizeCategory(cat)}
                  >
                    <Text style={[styles.randBtnText, randomCategories.has(cat) && styles.randBtnTextActive]}>🎲 RANDOM</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.pillGrid}>
                  {keywordsByCategory[cat].map((kw) => (
                    <TouchableOpacity
                      key={kw.id}
                      style={[styles.pill, styles.pillKeyword, selectedKeywords.has(kw.id) && styles.pillKeywordActive]}
                      onPress={() => toggleKeyword(kw.id)}
                    >
                      <Text style={[styles.pillKeywordText, selectedKeywords.has(kw.id) && styles.pillKeywordTextActive]}>{kw.label}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            ))}

            {/* Language */}
            <Text style={styles.sectionLabel}>Language</Text>
            <View style={styles.pillGrid}>
              {languages.map((l) => {
                const isInstrumental = l.code === 'instrumental';
                const isSelected = selectedLanguage === l.code;
                return (
                  <TouchableOpacity
                    key={l.code}
                    style={[
                      styles.pill,
                      isInstrumental && styles.pillDashed,
                      isSelected && (isInstrumental ? styles.pillLangInstrumentalActive : styles.pillLangActive),
                    ]}
                    onPress={() => setSelectedLanguage(l.code)}
                  >
                    <Text style={[
                      styles.pillLangText,
                      isSelected && (isInstrumental ? styles.pillLangInstrumentalTextActive : styles.pillLangTextActive),
                    ]}>
                      {l.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* What are you doing now? */}
            <Text style={styles.sectionLabel}>
              What are you doing now? <Text style={styles.optional}>(optional)</Text>
            </Text>
            <View style={styles.feelingWrapper}>
              <TextInput
                style={styles.textInput}
                value={feeling}
                onChangeText={(t) => setFeeling(t.slice(0, FEELING_MAX_LENGTH))}
                placeholder="e.g. Late night coding session, need focus..."
                placeholderTextColor={colors.border2}
                maxLength={FEELING_MAX_LENGTH}
              />
              <Text style={styles.charCounter}>{feeling.length}/{FEELING_MAX_LENGTH}</Text>
            </View>

            {/* DJ Name */}
            <Text style={styles.sectionLabel}>Your name?</Text>
            <TextInput
              style={[styles.textInput, nameError && !djName.trim() ? styles.inputError : null]}
              value={djName}
              onChangeText={(t) => { setDjName(t.slice(0, DJ_NAME_MAX_LENGTH)); if (nameError) setNameError(false); }}
              placeholder="e.g. DJ Nova"
              placeholderTextColor={colors.border2}
              maxLength={DJ_NAME_MAX_LENGTH}
            />
            {nameError && !djName.trim() && (
              <Text style={styles.errorText}>Your name is required to become the DJ</Text>
            )}

          </ScrollView>
        )}

        {/* Footer — vertical: submit button, then Cancel text link */}
        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.submitBtn, (loading || (!selectedGenre && !isRandomGenre)) && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={loading || (!selectedGenre && !isRandomGenre)}
          >
            <Text style={styles.submitBtnText}>Take the Stage</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
    </>
  );

  return (
    <Modal
      visible={visible}
      transparent={isSheet}
      animationType={isSheet ? 'fade' : 'slide'}
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape']}
    >
      {isSheet ? (
        <View style={styles.backdrop}>
          <Glass borderRadius={radius.rail} variant="strong" floating style={styles.sheet}>
            {inner}
          </Glass>
        </View>
      ) : (
        <View style={styles.container}>{inner}</View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  container:    { flex: 1, backgroundColor: colors.bg },
  scrollFlex:   { flex: 1 },

  // Regular width — centered glass sheet over a dimmed backdrop
  backdrop:     { flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  sheet:        { width: '100%', maxWidth: 560, maxHeight: '88%' },

  // Header — centered
  header:       { alignItems: 'center', padding: 20, paddingTop: 60, paddingBottom: 20, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerSheet:  { paddingTop: 24 },
  title:        { fontFamily: 'BebasNeue_400Regular', fontSize: 32, color: colors.text, letterSpacing: 1 },
  subtitle:     { fontSize: 13, color: colors.textMuted, marginTop: 6, textAlign: 'center', letterSpacing: 0.3 },

  loadingContainer: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content:      { padding: 20, paddingBottom: 20 },

  sectionLabel: { fontFamily: fonts.semiBold, fontSize: 13, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10, marginTop: 20 },
  optional:     { fontFamily: fonts.regular, color: colors.border2, textTransform: 'none', letterSpacing: 0 },

  // Pills — genre & base
  pillGrid:     { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  pill:         { paddingHorizontal: 18, paddingVertical: 9, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  pillDashed:   { borderStyle: 'dashed' },
  pillActive:   { borderColor: colors.accent, backgroundColor: colors.accentDim },
  // Genre pill text: semibold + uppercase (web: font-weight:600, text-transform:uppercase)
  pillText:     { fontFamily: fonts.semiBold, color: colors.textDim, fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5 },
  pillTextActive: { color: colors.text },

  // Keyword pills — indigo when selected (web: font-size:12, font-weight:500)
  pillKeyword:          { paddingHorizontal: 14, paddingVertical: 7, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.border, backgroundColor: colors.surface },
  pillKeywordActive:    { borderColor: colors.indigo, backgroundColor: 'rgba(99,102,241,0.12)' },
  pillKeywordText:      { fontFamily: fonts.medium, color: colors.textMuted, fontSize: 12 },
  pillKeywordTextActive: { color: colors.indigo },

  // Language pills — green when selected (web: font-size:12, font-weight:500)
  pillLangText:                { fontFamily: fonts.medium, color: colors.textMuted, fontSize: 12 },
  pillLangActive:              { borderColor: colors.green, backgroundColor: 'rgba(34,197,94,0.12)' },
  pillLangTextActive:          { color: colors.green },
  pillLangInstrumentalActive:  { borderColor: colors.textMuted, backgroundColor: 'rgba(100,116,139,0.12)' },
  pillLangInstrumentalTextActive: { color: colors.textMuted },

  // Mood category
  kwCategory:       { marginBottom: 16 },
  kwCategoryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  // web: font-size:11, font-weight:500, color:--border-2, uppercase, letter-spacing:0.5
  kwCategoryLabel:  { fontFamily: fonts.medium, fontSize: 11, color: colors.border2, textTransform: 'uppercase', letterSpacing: 0.5 },
  randBtn:          { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1.5, borderColor: colors.border, borderStyle: 'dashed' },
  randBtnActive:    { borderColor: colors.indigo, backgroundColor: 'rgba(99,102,241,0.12)' },
  randBtnText:      { fontFamily: fonts.medium, color: colors.textMuted, fontSize: 11 },
  randBtnTextActive: { color: colors.indigo },

  // Text inputs
  feelingWrapper:   { position: 'relative' },
  textInput:        { fontFamily: fonts.regular, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 12, paddingRight: 52, color: colors.text, fontSize: 14 },
  charCounter:      { fontFamily: fonts.regular, position: 'absolute', right: 10, top: 0, bottom: 0, textAlignVertical: 'center', color: colors.border2, fontSize: 10 },
  inputError:       { borderColor: colors.red },
  errorText:        { fontFamily: fonts.regular, color: colors.red, fontSize: 12, marginTop: 4 },

  // Footer — vertical layout
  footer:        { padding: 20, paddingBottom: 40, borderTopWidth: 1, borderTopColor: colors.border, gap: 12 },
  submitBtn:     { paddingVertical: 14, borderRadius: radius.sm, backgroundColor: colors.accent, alignItems: 'center' },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { fontFamily: fonts.bold, color: '#000', fontSize: 15 },
  cancelBtn:     { alignItems: 'center', paddingVertical: 4 },
  cancelBtnText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
});
