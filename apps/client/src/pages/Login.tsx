/**
 * Copyright (c) 2024-2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 */

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { TextField, Label, Input, Card, Button } from '@heroui/react';
import { X } from 'lucide-react';
import { getBaseURL } from '@/utils/base-url';

/**
 * Customer login page using Better Auth email + password or magic link.
 * Session cookies are managed server-side via /api/auth/* endpoints.
 */
export default function LoginPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [useMagicLink, setUseMagicLink] = useState(false);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if already authenticated — redirect to account
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const apiBase = getBaseURL() || '';
        const resp = await fetch(`${apiBase}/api/auth/session`);
        const data = await resp.json();
        if (data.session?.user) {
          const returnTo = searchParams.get('returnTo') || '/account';
          navigate(returnTo);
        }
      } catch {
        // Not authenticated, stay on login page
      }
    };
    checkAuth();
  }, [navigate, searchParams]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!email) {
      setError(t('login-email-required'));
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const apiBase = getBaseURL() || '';

      if (useMagicLink) {
        // Magic link flow — sends an email with a sign-in link
        await fetch(`${apiBase}/api/auth/sign-in/email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
      } else {
        // Email + password flow
        if (!password) {
          setError(t('login-password-required'));
          setLoading(false);
          return;
        }
        const resp = await fetch(`${apiBase}/api/auth/sign-in/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password }),
          credentials: 'include',
        });

        if (!resp.ok) {
          const data = await resp.json();
          throw new Error(data?.message || 'Invalid credentials');
        }
      }

      setSent(true);
    } catch (err) {
      console.error('Login error:', err);
      setError(err instanceof Error ? err.message : t('login-error'));
      setLoading(false);
    }
  };

  if (sent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-blue-50 to-indigo-100 p-4">
        <Card className="w-full max-w-md">
          <Card.Header className="flex gap-3 justify-center">
            <div className="text-center">
              <h1 className="text-2xl font-bold">{t('login-check-email')}</h1>
            </div>
          </Card.Header>
          <Card.Content className="gap-4">
            <div className="text-center space-y-4">
              <p className="text-gray-600">
                {useMagicLink ? t('login-sent-link') : t('login-success')}
              </p>
              <p className="font-semibold text-lg">{email}</p>

              <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                <p className="text-sm text-gray-700">
                  {useMagicLink ? t('login-instructions') : t('login-welcome-back')}
                </p>
              </div>

              <div className="pt-4 border-t">
                <p className="text-sm text-gray-500 mb-4">
                  {t('login-didnt-receive')}
                </p>
                <Button
                  variant="tertiary"
                  onClick={() => {
                    setSent(false);
                    setEmail('');
                    setPassword('');
                  }}
                  className="w-full"
                >
                  {t('login-try-another-email')}
                </Button>
              </div>
            </div>
          </Card.Content>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-blue-50 to-indigo-100 p-4">
      <Card className="w-full max-w-md">
        <Card.Header className="flex gap-3 flex-col justify-center">
          <div className="text-center">
            <h1 className="text-3xl font-bold">{t('login-title')}</h1>
            <p className="text-gray-500 mt-2">
              {t('login-subtitle')}
            </p>
          </div>
        </Card.Header>

        <Card.Content className="gap-6">
          <form onSubmit={handleLogin} className="space-y-4">
            <TextField
              name="email"
              type="email"
              isRequired
              isInvalid={!!error}
              className="w-full"
            >
              <Label>{t('login-email')}</Label>
              <div className="flex items-center">
                <Input
                  placeholder={t('login-enter-email')}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={loading}
                  fullWidth
                />
                {email && (
                  <button
                    type="button"
                    onClick={() => setEmail('')}
                    className="ml-2 p-1 text-gray-400 hover:text-gray-600"
                    aria-label="Clear email"
                  >
                    <X size={18} />
                  </button>
                )}
              </div>
            </TextField>

            {!useMagicLink && (
              <TextField
                name="password"
                type="password"
                isRequired={!useMagicLink}
                className="w-full"
              >
                <Label>{t('login-password')}</Label>
                <Input
                  placeholder={t('login-enter-password')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={loading}
                  fullWidth
                />
              </TextField>
            )}

            {error && (
              <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            {/* Toggle between password and magic link */}
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useMagicLink}
                  onChange={(e) => setUseMagicLink(e.target.checked)}
                  className="rounded border-gray-300"
                />
                <span className="text-sm text-gray-600">
                  {t('login-magic-link') || 'Use magic link instead'}
                </span>
              </label>
            </div>

            <Button
              type="submit"
              className="w-full font-semibold"
              isDisabled={loading || !email}
              isPending={loading}
            >
              {loading
                ? t('login-sending')
                : useMagicLink
                  ? t('login-send-link')
                  : t('login-sign-in')}
            </Button>
          </form>

          <div className="text-center text-sm text-gray-600">
            <p>
              {useMagicLink
                ? t('login-passwordless-info')
                : t('login-account-info')}
            </p>
          </div>

          <div className="pt-4 border-t text-center text-sm">
            <p className="text-gray-600 mb-2">
              {t('login-new-customer')}
            </p>
            <p className="text-gray-500">
              {useMagicLink
                ? t('login-signup-auto')
                : t('login-create-account')}
            </p>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
