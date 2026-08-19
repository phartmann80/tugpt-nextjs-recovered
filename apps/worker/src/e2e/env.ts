/**
 * @file env.ts
 * @description Environment loading for the milestone #1 harness.
 *
 * The harness is designed to run ON the deployment server using the env files
 * that already exist there (`/etc/tugpt/worker.env`, and optionally
 * `/etc/tugpt/web.env`). It deliberately requires no new credentials: if the
 * workers can reach Supabase, so can the harness.
 *
 * Values are read from the process environment first, then from any env files
 * passed via `--env-file`. Nothing here ever logs a secret value.
 */

import { readFileSync } from 'node:fs';

export interface HarnessEnv {
  supabaseUrl: string;
  serviceRoleKey: string;
  /**
   * Optional. Needed only for the human-review leg, which signs in as a real
   * user to obtain a JWT — `auth.uid()` is NULL under the service-role key, and
   * approve/edit/reject reject that with FORBIDDEN. Usually lives in web.env.
   */
  anonKey: string | null;
}

/**
 * Parse a dotenv-style file. Intentionally minimal: `KEY=value`, optional
 * `export ` prefix, `#` comments, and surrounding single/double quotes.
 * Does not attempt interpolation — worker.env is a flat systemd EnvironmentFile.
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const withoutExport = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;

    const key = withoutExport.slice(0, eq).trim();
    let value = withoutExport.slice(eq + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }

  return out;
}

/**
 * Resolve harness configuration from process.env plus any --env-file paths.
 *
 * @throws Error naming the missing variables (never their values) when the
 * required Supabase URL or service-role key cannot be found.
 */
export function loadHarnessEnv(envFilePaths: string[]): HarnessEnv {
  const merged: Record<string, string> = {};

  for (const path of envFilePaths) {
    let contents: string;
    try {
      contents = readFileSync(path, 'utf-8');
    } catch {
      throw new Error(
        `Could not read env file: ${path}. Pass a readable path with --env-file, or export the variables directly.`
      );
    }
    Object.assign(merged, parseEnvFile(contents));
  }

  // Process env wins over files, so an operator can override ad hoc.
  const pick = (key: string): string | null => process.env[key] ?? merged[key] ?? null;

  const supabaseUrl = pick('NEXT_PUBLIC_SUPABASE_URL');
  const serviceRoleKey = pick('SUPABASE_SERVICE_ROLE_KEY');
  const anonKey = pick('NEXT_PUBLIC_SUPABASE_ANON_KEY');

  const missing: string[] = [];
  if (!supabaseUrl) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!serviceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Searched process env and ${envFilePaths.length > 0 ? envFilePaths.join(', ') : '(no env files given)'}.`
    );
  }

  return {
    supabaseUrl: supabaseUrl as string,
    serviceRoleKey: serviceRoleKey as string,
    anonKey,
  };
}

/** Redact a secret for safe display: never more than a short prefix. */
export function fingerprint(secret: string): string {
  if (secret.length <= 8) return '<set>';
  return `<set, ${secret.length} chars, starts ${secret.slice(0, 4)}...>`;
}
