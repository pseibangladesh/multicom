Yes, verification needs a way to send email, and right now nothing is set up. The code already sends through Mailgun, but MAILGUN_API_KEY and MAILGUN_DOMAIN are empty in your .env. So the email is never sent; the link is only written to the worker log, and the user waits for an email that never comes.

You don't need to run your own mail server. You have three options:

1. Set up Mailgun (recommended; needed before real customers sign up)
1. Create a Mailgun account and add a sending domain, e.g. mg.yourstore.com.
2. Add the DNS records Mailgun gives you (SPF, DKIM, MX) at your domain provider. Without them, emails get rejected or land in spam.
3. Put the values in the root .env:
MAILGUN_API_KEY=key-…
MAILGUN_DOMAIN=mg.yourstore.com
MAILGUN_BASE_URL=https://api.mailgun.net   # or https://api.eu.mailgun.net for an EU account
4. For production, store the API key as a secret: cd apps/merchant && npx wrangler secret put MAILGUN_API_KEY.

No code changes are needed. The sign-up email and the "send again" button start working as soon as these values are set.

2. Local development right now (no setup)
When someone signs up, the terminal running npm run dev prints:
[Auth] Mailgun is not configured; verify-email link for user@x.com: http://localhost:8787/api/auth/verify-email?token=…
Opening that link in the browser confirms the account and signs the user in. Emails listed in ADMIN_EMAILS never need confirming.