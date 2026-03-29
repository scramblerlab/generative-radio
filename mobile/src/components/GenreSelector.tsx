import React, { useState, useEffect, useMemo } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, ActivityIndicator, Switch,
} from 'react-native';
import { Genre, Keyword, Language, AdvancedOptions } from '@radio/shared';
import { BACKEND_URL } from '../config';
import { colors, radius } from './theme';

const DEFAULT_INFERENCE_STEPS = 8;
const DEFAULT_DJ_LOCK_MINUTES = 3;

const TIME_SIGNATURES = [
  { value: '', label: 'None' },
  { value: '2', label: '2/4' },
  { value: '3', label: '3/4' },
  { value: '4', label: '4/4' },
  { value: '6', label: '6/8' },
];

const DIT_MODELS = [
  { value: 'turbo', label: 'turbo' },
  { value: 'turbo-shift1', label: 'turbo-shift1' },
  { value: 'turbo-shift3', label: 'turbo-shift3' },
  { value: 'turbo-continuous', label: 'turbo-continuous' },
];

const MOOD_CATEGORY_ORDER = ['emotion', 'atmosphere', 'instrument'];
const MOOD_CATEGORY_LABELS: Record<string, string> = {
  emotion: 'Emotion',
  atmosphere: 'Atmosphere',
  instrument: 'Instrument',
};

interface Props {
  onStart: (genres: string[], keywords: string[], language: string, feeling: string, djName: string, advancedOptions?: AdvancedOptions) => void;
  onBackToPlayer?: () => void;
  isStarted?: boolean; // True when a session is already running
}

export function GenreSelector({ onStart, onBackToPlayer, isStarted }: Props) {
  const [genres, setGenres] = useState<Genre[]>([]);
  const [keywords, setKeywords] = useState<Keyword[]>([]);
  const [languages, setLanguages] = useState<Language[]>([]);
  const [selectedGenre, setSelectedGenre] = useState<string>('rock');
  const [isRandomGenre, setIsRandomGenre] = useState(false);
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [randomCategories, setRandomCategories] = useState<Set<string>>(new Set());
  const [selectedLanguage, setSelectedLanguage] = useState<string>('en');
  const [feeling, setFeeling] = useState('');
  const [loading, setLoading] = useState(true);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [timeSignature, setTimeSignature] = useState('');
  const [inferenceSteps, setInferenceSteps] = useState(DEFAULT_INFERENCE_STEPS);
  const [ditModel, setDitModel] = useState('turbo');
  const [thinking, setThinking] = useState(true);
  const [useCotCaption, setUseCotCaption] = useState(true);
  const [useCotMetas, setUseCotMetas] = useState(true);
  const [useCotLanguage, setUseCotLanguage] = useState(true);
  const [djLockMinutes, setDjLockMinutes] = useState(DEFAULT_DJ_LOCK_MINUTES);

  useEffect(() => {
    Promise.all([
      fetch(`${BACKEND_URL}/api/genres`).then((r) => r.json()),
      fetch(`${BACKEND_URL}/api/advanced-options`).then((r) => r.json()),
    ])
      .then(([genreData, savedOpts]: [{ genres: Genre[]; keywords: Keyword[]; languages: Language[] }, Record<string, unknown>]) => {
        setGenres(genreData.genres);
        setKeywords(genreData.keywords);
        setLanguages(genreData.languages);
        if (savedOpts && Object.keys(savedOpts).length > 0) {
          if (savedOpts.timeSignature !== undefined) setTimeSignature((savedOpts.timeSignature as string) ?? '');
          if (savedOpts.inferenceSteps !== undefined) setInferenceSteps(savedOpts.inferenceSteps as number);
          if (savedOpts.model !== undefined) setDitModel(savedOpts.model as string);
          if (savedOpts.thinking !== undefined) setThinking(savedOpts.thinking as boolean);
          if (savedOpts.useCotCaption !== undefined) setUseCotCaption(savedOpts.useCotCaption as boolean);
          if (savedOpts.useCotMetas !== undefined) setUseCotMetas(savedOpts.useCotMetas as boolean);
          if (savedOpts.useCotLanguage !== undefined) setUseCotLanguage(savedOpts.useCotLanguage as boolean);
          if (savedOpts.djLockSeconds !== undefined) setDjLockMinutes(Math.round((savedOpts.djLockSeconds as number) / 60));
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const keywordsByCategory = useMemo(() => {
    const map: Record<string, Keyword[]> = {};
    for (const kw of keywords) {
      if (!map[kw.category]) map[kw.category] = [];
      map[kw.category].push(kw);
    }
    return map;
  }, [keywords]);

  const handleStart = () => {
    const genreArg = isRandomGenre ? ['__random__'] : [selectedGenre];
    const kwList = [...selectedKeywords];
    for (const cat of randomCategories) {
      const catKws = keywordsByCategory[cat] ?? [];
      if (catKws.length > 0) {
        const rand = catKws[Math.floor(Math.random() * catKws.length)];
        kwList.push(rand.id);
      }
    }
    const adv: AdvancedOptions = {
      timeSignature: timeSignature || undefined,
      inferenceSteps,
      model: ditModel,
      thinking,
      useCotCaption,
      useCotMetas,
      useCotLanguage,
      djLockSeconds: djLockMinutes * 60,
    };
    onStart(genreArg, kwList, selectedLanguage, feeling, '', adv);
  };

  const toggleKeyword = (id: string) => {
    setSelectedKeywords((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleRandomCategory = (cat: string) => {
    setRandomCategories((prev) => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator color={colors.accent} size="large" />
        <Text style={styles.loadingText}>Loading...</Text>
      </View>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {onBackToPlayer && (
        <TouchableOpacity style={styles.backBtn} onPress={onBackToPlayer}>
          <Text style={styles.backBtnText}>← Now Playing</Text>
        </TouchableOpacity>
      )}

      <Text style={styles.heading}>Choose Your Vibe</Text>

      {/* Genre grid */}
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
              onPress={() => toggleRandomCategory(cat)}
            >
              <Text style={[styles.randBtnText, randomCategories.has(cat) && styles.randBtnTextActive]}>🎲 Random</Text>
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

      {/* Feeling / context */}
      <Text style={styles.sectionLabel}>What are you doing? <Text style={styles.optional}>(optional)</Text></Text>
      <TextInput
        style={styles.textInput}
        value={feeling}
        onChangeText={setFeeling}
        placeholder="e.g. cooking, studying, working out…"
        placeholderTextColor={colors.textMuted}
        maxLength={200}
        multiline
      />
      <Text style={styles.charCount}>{feeling.length}/200</Text>

      {/* Advanced options toggle */}
      <TouchableOpacity style={styles.advancedToggle} onPress={() => setAdvancedOpen((o) => !o)}>
        <Text style={styles.advancedToggleText}>{advancedOpen ? '▲' : '▼'} Advanced Options</Text>
      </TouchableOpacity>

      {advancedOpen && (
        <View style={styles.advancedPanel}>
          <Text style={styles.advLabel}>Time Signature</Text>
          <View style={styles.pillGrid}>
            {TIME_SIGNATURES.map((ts) => (
              <TouchableOpacity
                key={ts.value}
                style={[styles.pill, timeSignature === ts.value && styles.pillActive]}
                onPress={() => setTimeSignature(ts.value)}
              >
                <Text style={[styles.pillText, timeSignature === ts.value && styles.pillTextActive]}>{ts.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.advLabel}>Model</Text>
          <View style={styles.pillGrid}>
            {DIT_MODELS.map((m) => (
              <TouchableOpacity
                key={m.value}
                style={[styles.pill, ditModel === m.value && styles.pillActive]}
                onPress={() => setDitModel(m.value)}
              >
                <Text style={[styles.pillText, ditModel === m.value && styles.pillTextActive]}>{m.label}</Text>
              </TouchableOpacity>
            ))}
          </View>

          <Text style={styles.advLabel}>Inference Steps: {inferenceSteps}</Text>
          <View style={styles.stepRow}>
            <TouchableOpacity onPress={() => setInferenceSteps((s) => Math.max(4, s - 1))} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.stepVal}>{inferenceSteps}</Text>
            <TouchableOpacity onPress={() => setInferenceSteps((s) => Math.min(100, s + 1))} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>+</Text>
            </TouchableOpacity>
          </View>

          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Thinking</Text>
            <Switch value={thinking} onValueChange={setThinking} trackColor={{ true: colors.accent }} />
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>CoT Caption</Text>
            <Switch value={useCotCaption} onValueChange={setUseCotCaption} trackColor={{ true: colors.accent }} />
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>CoT Metas</Text>
            <Switch value={useCotMetas} onValueChange={setUseCotMetas} trackColor={{ true: colors.accent }} />
          </View>
          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>CoT Language</Text>
            <Switch value={useCotLanguage} onValueChange={setUseCotLanguage} trackColor={{ true: colors.accent }} />
          </View>

          <Text style={styles.advLabel}>DJ Lock: {djLockMinutes} min</Text>
          <View style={styles.stepRow}>
            <TouchableOpacity onPress={() => setDjLockMinutes((m) => Math.max(1, m - 1))} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>−</Text>
            </TouchableOpacity>
            <Text style={styles.stepVal}>{djLockMinutes}</Text>
            <TouchableOpacity onPress={() => setDjLockMinutes((m) => Math.min(120, m + 1))} style={styles.stepBtn}>
              <Text style={styles.stepBtnText}>+</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Start / Update button */}
      <TouchableOpacity style={styles.startBtn} onPress={handleStart}>
        <Text style={styles.startBtnText}>{isStarted ? 'Update Vibe' : 'Start Radio'}</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 20, paddingBottom: 60 },
  loadingContainer: { flex: 1, backgroundColor: colors.bg, justifyContent: 'center', alignItems: 'center' },
  loadingText: { color: colors.textMuted, marginTop: 12 },
  backBtn: { marginBottom: 16 },
  backBtnText: { color: colors.accent, fontSize: 14 },
  heading: { fontSize: 28, fontWeight: '700', color: colors.text, marginBottom: 24 },
  sectionLabel: { fontSize: 13, fontWeight: '600', color: colors.textDim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10, marginTop: 20 },
  optional: { fontWeight: '400', color: colors.textMuted },
  pillGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginBottom: 4 },
  pill: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border2, backgroundColor: colors.surface },
  pillActive: { borderColor: colors.accent, backgroundColor: 'rgba(245,158,11,0.12)' },
  pillText: { color: colors.textDim, fontSize: 13 },
  pillTextActive: { color: colors.accent },
  kwCategory: { marginBottom: 16 },
  kwCategoryHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  kwCategoryLabel: { fontSize: 12, color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.8 },
  randBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border },
  randBtnActive: { borderColor: colors.indigo, backgroundColor: 'rgba(99,102,241,0.12)' },
  randBtnText: { color: colors.textMuted, fontSize: 11 },
  randBtnTextActive: { color: colors.indigo },
  textInput: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, padding: 12, color: colors.text, fontSize: 14, minHeight: 60 },
  charCount: { color: colors.textMuted, fontSize: 11, textAlign: 'right', marginTop: 4 },
  advancedToggle: { marginTop: 20, paddingVertical: 10 },
  advancedToggleText: { color: colors.textDim, fontSize: 13 },
  advancedPanel: { backgroundColor: colors.surface, borderRadius: radius.sm, padding: 16, marginTop: 4, borderWidth: 1, borderColor: colors.border },
  advLabel: { color: colors.textDim, fontSize: 12, marginBottom: 8, marginTop: 12 },
  stepRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  stepBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: colors.surface2, justifyContent: 'center', alignItems: 'center' },
  stepBtnText: { color: colors.text, fontSize: 18 },
  stepVal: { color: colors.text, fontSize: 16, minWidth: 30, textAlign: 'center' },
  toggleRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: colors.border },
  toggleLabel: { color: colors.text, fontSize: 14 },
  startBtn: { marginTop: 32, backgroundColor: colors.accent, borderRadius: radius.sm, paddingVertical: 16, alignItems: 'center' },
  startBtnText: { color: '#000', fontSize: 16, fontWeight: '700' },
});
