import React, { useState } from 'react';
import {
  View, Text, ScrollView, TouchableOpacity, TextInput,
  StyleSheet, Modal, ActivityIndicator,
} from 'react-native';
import {
  AuthError,
  NICKNAME_MAX,
  PASSWORD_MAX,
  validateEmail,
  validateNickname,
  validatePassword,
} from '@radio/shared';
import { colors, fonts, radius } from './theme';

type Mode = 'login' | 'signup';

interface Props {
  visible: boolean;
  onClose: () => void;
  signup: (email: string, password: string, nickname: string, inviteCode: string) => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  /** Shown above the form when the modal was opened by a refused DJ claim
   *  rather than by the user tapping "Sign in". */
  notice?: string | null;
}

export function AuthModal({ visible, onClose, signup, login, notice }: Props) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [nickname, setNickname] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const isSignup = mode === 'signup';

  const switchMode = (next: Mode) => {
    setMode(next);
    setFieldError(null);
    setFormError(null);
  };

  const handleSubmit = async () => {
    if (submitting) return;

    // Pre-flight against the same rules the server enforces, so the common
    // mistakes never cost a round trip. The server remains authoritative.
    const problem =
      validateEmail(email) ??
      validatePassword(password) ??
      (isSignup ? validateNickname(nickname) : null) ??
      (isSignup && !inviteCode.trim() ? 'An invite code is required to sign up' : null);
    if (problem) {
      setFieldError(problem);
      setFormError(null);
      return;
    }

    setFieldError(null);
    setFormError(null);
    setSubmitting(true);
    try {
      if (isSignup) {
        await signup(email, password, nickname, inviteCode.trim());
      } else {
        await login(email, password);
      }
      // Only clear the secrets — a failed attempt keeps what was typed.
      setPassword('');
      setInviteCode('');
      onClose();
    } catch (err) {
      if (err instanceof AuthError) {
        setFormError(
          err.isUnconfigured
            ? 'Accounts are not set up on this server yet.'
            : err.message,
        );
      } else {
        console.error('[Auth] Request failed:', err);
        setFormError('Could not reach the server — check your connection.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Text style={styles.title}>{isSignup ? 'CREATE ACCOUNT' : 'SIGN IN'}</Text>
          <Text style={styles.subtitle}>
            {isSignup
              ? 'Members can be the DJ and download tracks for offline play'
              : 'Sign in to use DJ mode and offline downloads'}
          </Text>
        </View>

        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          {notice && <Text style={styles.notice}>{notice}</Text>}

          <Text style={styles.sectionLabel}>Email</Text>
          <TextInput
            style={styles.textInput}
            value={email}
            onChangeText={setEmail}
            placeholder="you@example.com"
            placeholderTextColor={colors.border2}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
          />

          <Text style={styles.sectionLabel}>Password</Text>
          <TextInput
            style={styles.textInput}
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            placeholderTextColor={colors.border2}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={PASSWORD_MAX}
            textContentType={isSignup ? 'newPassword' : 'password'}
          />

          {isSignup && (
            <>
              <Text style={styles.sectionLabel}>
                Nickname <Text style={styles.optional}>(shown as the DJ name)</Text>
              </Text>
              <TextInput
                style={styles.textInput}
                value={nickname}
                onChangeText={setNickname}
                placeholder="e.g. DJ Nova"
                placeholderTextColor={colors.border2}
                autoCapitalize="none"
                autoCorrect={false}
                maxLength={NICKNAME_MAX}
              />

              <Text style={styles.sectionLabel}>Invite code</Text>
              <TextInput
                style={styles.textInput}
                value={inviteCode}
                onChangeText={setInviteCode}
                placeholder="Required to create an account"
                placeholderTextColor={colors.border2}
                autoCapitalize="none"
                autoCorrect={false}
              />
            </>
          )}

          {fieldError && <Text style={styles.errorText}>{fieldError}</Text>}
          {formError && <Text style={styles.errorText}>{formError}</Text>}
        </ScrollView>

        <View style={styles.footer}>
          <TouchableOpacity
            style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
            onPress={handleSubmit}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#000" />
            ) : (
              <Text style={styles.submitBtnText}>{isSignup ? 'CREATE ACCOUNT' : 'SIGN IN'}</Text>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.outlineBtn}
            onPress={() => switchMode(isSignup ? 'login' : 'signup')}
            disabled={submitting}
          >
            <Text style={styles.outlineBtnText}>
              {isSignup ? 'I ALREADY HAVE AN ACCOUNT' : 'CREATE AN ACCOUNT'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.cancelBtn} onPress={onClose} disabled={submitting}>
            <Text style={styles.cancelBtnText}>Cancel</Text>
          </TouchableOpacity>
        </View>
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

  notice: { fontFamily: fonts.regular, fontSize: 13, color: colors.accent, marginBottom: 4 },
  errorText: { fontFamily: fonts.regular, fontSize: 13, color: colors.red, marginTop: 20 },

  footer: { padding: 20, paddingBottom: 40, borderTopWidth: 1, borderTopColor: colors.border, gap: 12 },
  submitBtn: { paddingVertical: 14, borderRadius: radius.sm, backgroundColor: colors.accent, alignItems: 'center' },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { fontFamily: fonts.bold, color: '#000', fontSize: 15, letterSpacing: 0.5 },

  outlineBtn: { paddingVertical: 14, borderRadius: radius.sm, backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border2, alignItems: 'center' },
  outlineBtnText: { fontFamily: fonts.bold, color: colors.textMuted, fontSize: 15, letterSpacing: 0.5 },

  cancelBtn: { alignItems: 'center', paddingVertical: 4 },
  cancelBtnText: { fontFamily: fonts.regular, fontSize: 13, color: colors.textMuted },
});
