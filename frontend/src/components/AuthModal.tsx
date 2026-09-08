import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  AuthError,
  NICKNAME_MAX,
  PASSWORD_MAX,
  validateEmail,
  validateNickname,
  validatePassword,
} from '@radio/shared';
import { useAuth } from '../context/AuthContext';

type Mode = 'login' | 'signup';

interface AuthModalProps {
  onClose: () => void;
}

export function AuthModal({ onClose }: AuthModalProps) {
  const { login, signup } = useAuth();

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

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
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
    <div className="dj-panel-backdrop" onClick={onClose}>
      <div className="dj-panel auth-panel" onClick={(e) => e.stopPropagation()}>
        <header className="dj-panel__header">
          <h1 className="dj-panel__title">{isSignup ? 'Create Account' : 'Sign In'}</h1>
          <p className="dj-panel__subtitle">
            {isSignup
              ? 'Your nickname is the name listeners see when you DJ.'
              : 'Sign in to become a DJ.'}
          </p>
        </header>

        <form className="auth-form" onSubmit={handleSubmit}>
          <label className="auth-field">
            <span className="auth-field__label">Email</span>
            <input
              className="feeling-input auth-input"
              type="email"
              autoComplete="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>

          <label className="auth-field">
            <span className="auth-field__label">Password</span>
            <input
              className="feeling-input auth-input"
              type="password"
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              maxLength={PASSWORD_MAX}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>

          {isSignup && (
            <>
              <label className="auth-field">
                <span className="auth-field__label">Nickname <span className="optional">(your DJ name)</span></span>
                <input
                  className="feeling-input auth-input"
                  type="text"
                  autoComplete="nickname"
                  placeholder="e.g. DJ Nova"
                  maxLength={NICKNAME_MAX}
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                />
              </label>

              <label className="auth-field">
                <span className="auth-field__label">Invite code</span>
                <input
                  className="feeling-input auth-input"
                  type="text"
                  autoComplete="off"
                  value={inviteCode}
                  onChange={(e) => setInviteCode(e.target.value)}
                />
              </label>
            </>
          )}

          {(fieldError || formError) && (
            <p className="auth-error" role="alert">{fieldError ?? formError}</p>
          )}

          <div className="dj-panel__footer">
            <button className="start-button" type="submit" disabled={submitting}>
              {submitting ? 'Please wait…' : isSignup ? 'Create Account' : 'Sign In'}
            </button>
            <button
              className="dj-panel__close"
              type="button"
              onClick={() => switchMode(isSignup ? 'login' : 'signup')}
            >
              {isSignup ? 'Already have an account? Sign in' : 'Have an invite code? Create an account'}
            </button>
            <button className="dj-panel__close" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
