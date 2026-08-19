/**
 * @file args.ts
 * @description Command-line parsing for the milestone #1 harness.
 *
 * Kept in its own module so it can be unit-tested without importing
 * milestone1.ts, which runs `main()` as a side effect of being loaded.
 */

export interface HarnessArgs {
  command: string;
  envFiles: string[];
  timeoutMs: number;
}

/** Default env file: the one the systemd workers already use on the server. */
export const DEFAULT_ENV_FILE = '/etc/tugpt/worker.env';

export const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Parse `process.argv`-shaped input.
 *
 * @param argv Full argv including the node and script entries.
 * @throws Error on a flag that is missing its value or given a non-positive timeout.
 */
export function parseArgs(argv: string[]): HarnessArgs {
  const args = argv.slice(2);
  const envFiles: string[] = [];
  let command = '';
  let timeoutMs = DEFAULT_TIMEOUT_MS;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];

    if (a === '--env-file') {
      const next = args[++i];
      if (!next) throw new Error('--env-file requires a path');
      envFiles.push(next);
    } else if (a === '--timeout') {
      const next = args[++i];
      if (!next) throw new Error('--timeout requires a value in seconds');
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`invalid --timeout: ${next}`);
      }
      timeoutMs = parsed * 1000;
    } else if (!command) {
      command = a;
    }
  }

  if (envFiles.length === 0) envFiles.push(DEFAULT_ENV_FILE);

  return { command, envFiles, timeoutMs };
}
