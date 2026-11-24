/**
 * Create the login account for a store admin, without the public sign-up form.
 *
 *   npx tsx apps/merchant/scripts/create-admin.ts <email> [password] [options]
 *
 * Options:
 *   --name "Jane Doe"   display name (default: the part of the email before @)
 *   --reset-password    the account already exists: replace its password
 *   --remote            target API_BASE_URL (must be https) instead of http://localhost:8787
 *   --url <base>        target another worker, e.g. http://localhost:8799 (http only for localhost)
 *
 * If the password is left out, it is asked for without echoing it, so it doesn't
 * end up in your shell history.
 *
 * How it works: Durable Object storage can't be written from outside the Worker
 * (the local SQLite file is held open by wrangler, and remotely there's no file
 * at all). So the script calls POST /v1/setup/admin-user with the admin API key
 * (MERCHANT_SK). The Durable Object then writes the Better Auth `user` and
 * credential `account` rows with Better Auth's own adapter and password hasher
 * (scrypt), the same rows a sign-up would produce.
 *
 * Admin rights come only from ADMIN_EMAILS on the backend. The script checks
 * that and tells you if the email still needs adding.
 */
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { config as loadEnv, parse as parseEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_ENV = path.resolve(__dirname, '../../..', '.env');
const DEV_VARS = path.resolve(__dirname, '..', '.dev.vars');
loadEnv({ path: ROOT_ENV, quiet: true });

const USAGE = `Usage:
  npx tsx apps/merchant/scripts/create-admin.ts <email> [password] [--name "Jane Doe"] [--reset-password] [--remote | --url <base>]`;

interface Args {
  email: string;
  password?: string;
  name?: string;
  resetPassword: boolean;
  remote: boolean;
  url?: string;
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  let name: string | undefined;
  let resetPassword = false;
  let remote = false;
  let url: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--name') name = argv[++i];
    else if (a.startsWith('--name=')) name = a.slice('--name='.length);
    else if (a === '--reset-password') resetPassword = true;
    else if (a === '--remote') remote = true;
    else if (a === '--url') url = argv[++i];
    else if (a.startsWith('--url=')) url = a.slice('--url='.length);
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}\n\n${USAGE}`);
    else positional.push(a);
  }
  const [email, password] = positional;
  if (!email || positional.length > 2) throw new Error(USAGE);
  if (remote && url) throw new Error('Use either --remote or --url, not both');
  return { email: email.trim().toLowerCase(), password, name, resetPassword, remote, ...(url ? { url } : {}) };
}

/** https anywhere; plain http only to this machine. */
export function isSafeTarget(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Same rule as the backend's isAdminEmail (lib/session.ts). */
export function listsEmail(adminEmails: string | undefined, email: string): boolean {
  return (adminEmails ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());
}

function readVar(file: string, key: string): string | undefined {
  if (!existsSync(file)) return undefined;
  return parseEnv(readFileSync(file))[key];
}

async function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error('No password given and stdin is not a terminal. Pass it as the second argument.');
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  // Print the prompt, then swallow the echo of what is typed.
  const write = (rl as unknown as { _writeToOutput: (s: string) => void });
  let prompted = false;
  write._writeToOutput = (s: string) => {
    if (!prompted) {
      process.stdout.write(s);
      prompted = true;
    }
  };
  const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const baseUrl = (args.url ?? (args.remote ? process.env.API_BASE_URL : 'http://localhost:8787'))?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error('--remote needs API_BASE_URL in .env');
  if (!isSafeTarget(baseUrl)) {
    throw new Error(`Refusing to send a password to ${baseUrl} over plain HTTP. Use https (http is allowed only for localhost).`);
  }

  const adminKey = process.env.MERCHANT_SK;
  if (!adminKey) throw new Error(`MERCHANT_SK is not set in ${ROOT_ENV}`);

  let password = args.password;
  if (!password) {
    password = await promptHidden(`Password for ${args.email}: `);
    const again = await promptHidden('Repeat password: ');
    if (password !== again) throw new Error('Passwords do not match');
  }
  if (password.length < 8) throw new Error('Password must be at least 8 characters');

  console.log(`👤 Provisioning ${args.email} on ${baseUrl}...`);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/v1/setup/admin-user`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: args.email,
        password,
        ...(args.name ? { name: args.name } : {}),
        reset_password: args.resetPassword,
      }),
    });
  } catch (err) {
    throw new Error(`Cannot reach ${baseUrl}. Is the worker running (npm run dev)?`, { cause: err });
  }

  const body = (await res.json().catch(() => ({}))) as {
    status?: 'created' | 'password_reset' | 'exists';
    is_admin?: boolean;
    error?: { message?: string } | string;
  };
  if (!res.ok) {
    const msg = typeof body.error === 'string' ? body.error : body.error?.message;
    if (res.status === 401 || res.status === 403) {
      throw new Error(`The backend rejected MERCHANT_SK (HTTP ${res.status}). It must match the key the worker was started with.`);
    }
    throw new Error(`HTTP ${res.status}: ${msg ?? res.statusText}`);
  }

  if (body.status === 'created') console.log('   ✅ Account created');
  else if (body.status === 'password_reset') console.log('   ✅ Password replaced');
  else {
    console.log('   ↩  This account already exists; password left unchanged.');
    console.log('      Run again with --reset-password to replace it.');
  }

  // Admin rights: the backend's answer is what counts; the files explain why.
  const inRootEnv = listsEmail(process.env.ADMIN_EMAILS, args.email);
  const inDevVars = listsEmail(readVar(DEV_VARS, 'ADMIN_EMAILS'), args.email);

  if (body.is_admin) {
    console.log('   ✅ The backend recognises this email as an admin (ADMIN_EMAILS).');
  } else {
    console.log('\n⚠️  The backend does NOT treat this email as an admin yet.');
    if (!inRootEnv) console.log(`   • Add it to ADMIN_EMAILS in ${ROOT_ENV} (comma-separated).`);
    if (args.remote || (args.url && !args.url.includes('localhost') && !args.url.includes('127.0.0.1'))) {
      console.log('   • Set it on the deployed worker: npx wrangler secret put ADMIN_EMAILS');
    } else if (!inDevVars) {
      console.log(`   • Add it to ADMIN_EMAILS in ${DEV_VARS}: that is the file the local worker reads.`);
    }
    console.log('   • Then restart the worker and sign in again.');
  }
  if (body.is_admin && !inRootEnv) {
    console.log(`   ℹ️  Also add it to ADMIN_EMAILS in ${ROOT_ENV} to keep the two files in sync.`);
  }

  console.log(`\nSign in at ${process.env.STORE_URL ?? 'the storefront'} with ${args.email}.`);
}

// Run only as a script, so tests can import the helpers.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    console.error(`❌ ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
