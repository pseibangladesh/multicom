/**
 * Account emails sent by Better Auth (verify address, reset password).
 *
 * Sent through Mailgun when MAILGUN_API_KEY and MAILGUN_DOMAIN are set.
 * Without them (local development) the link is written to the log instead, so
 * a developer can still verify an account; a production store must configure
 * Mailgun, or customers cannot verify their email and therefore cannot sign in.
 */
import { sendMailgunEmail } from '../mailgun';
import type { Env } from '../types';

export interface AuthEmailEnv {
  MAILGUN_API_KEY?: string;
  MAILGUN_DOMAIN?: string;
  MAILGUN_BASE_URL?: string;
  MAILGUN_USER?: string;
  STORE_NAME?: string;
}

export type AuthEmailKind = 'verify-email' | 'reset-password';

const COPY: Record<AuthEmailKind, { subject: (store: string) => string; intro: string; action: string }> = {
  'verify-email': {
    subject: (store) => `Confirm your email for ${store}`,
    intro: 'Please confirm your email address to finish setting up your account.',
    action: 'Confirm email',
  },
  'reset-password': {
    subject: (store) => `Reset your ${store} password`,
    intro: 'We received a request to reset your password. If it was not you, ignore this email.',
    action: 'Reset password',
  },
};

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Builds the email; exported for tests. */
export function buildAuthEmail(kind: AuthEmailKind, url: string, storeName: string) {
  const copy = COPY[kind];
  const store = storeName || 'our store';
  const subject = copy.subject(store);
  const text = `${copy.intro}\n\n${copy.action}: ${url}\n\nThis link expires soon and can be used once.`;
  const html =
    `<p>${escapeHtml(copy.intro)}</p>` +
    `<p><a href="${escapeHtml(url)}">${escapeHtml(copy.action)}</a></p>` +
    `<p style="color:#666;font-size:12px">This link expires soon and can be used once.</p>`;
  return { subject, text, html };
}

export function mailConfigured(env: AuthEmailEnv): boolean {
  return !!(env.MAILGUN_API_KEY && env.MAILGUN_DOMAIN);
}

export async function sendAuthEmail(env: AuthEmailEnv, kind: AuthEmailKind, to: string, url: string): Promise<void> {
  if (!mailConfigured(env)) {
    console.warn(`[Auth] Mailgun is not configured; ${kind} link for ${to}: ${url}`);
    return;
  }
  const { subject, text, html } = buildAuthEmail(kind, url, env.STORE_NAME ?? '');
  const result = await sendMailgunEmail(env as Env, {
    to,
    subject,
    text,
    html,
    ...(env.MAILGUN_USER ? { from: env.MAILGUN_USER } : {}),
  });
  if (!result.success) {
    // Better Auth turns a throw into an error response, so the user knows the
    // email was not sent instead of waiting for it.
    throw new Error(`Could not send the ${kind} email (${result.status} ${result.statusText})`);
  }
}
