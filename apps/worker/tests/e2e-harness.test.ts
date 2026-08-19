/**
 * @file e2e-harness.test.ts
 * @description Unit tests for the pure parts of the milestone #1 harness
 * (src/e2e/). The harness itself talks to a live database and is run manually
 * on the server, but its argument and env-file parsing are pure and are the
 * parts most likely to break silently — a mis-parsed `--env-file` would send
 * the harness at the wrong database.
 *
 * milestone1.ts is deliberately NOT imported here: loading it executes main().
 */
import { describe, it, expect } from 'vitest';
import { parseArgs, DEFAULT_ENV_FILE, DEFAULT_TIMEOUT_MS } from '../src/e2e/args';
import { parseEnvFile, fingerprint } from '../src/e2e/env';
import {
  ORG_SLUG,
  REVIEWER_EMAIL,
  PROVIDER_PHONE_NUMBER_ID,
  CONNECTION_PHONE,
  CONTACT_PHONE,
} from '../src/e2e/constants';

const argv = (...args: string[]): string[] => ['node', 'milestone1.ts', ...args];

describe('parseArgs', () => {
  it('defaults to the systemd worker env file and a 180s timeout', () => {
    const parsed = parseArgs(argv('preflight'));
    expect(parsed.command).toBe('preflight');
    expect(parsed.envFiles).toEqual([DEFAULT_ENV_FILE]);
    expect(parsed.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it('collects multiple --env-file values in order', () => {
    const parsed = parseArgs(
      argv('all', '--env-file', '/etc/tugpt/worker.env', '--env-file', '/etc/tugpt/web.env')
    );
    expect(parsed.envFiles).toEqual(['/etc/tugpt/worker.env', '/etc/tugpt/web.env']);
  });

  it('does not fall back to the default once an env file is given', () => {
    const parsed = parseArgs(argv('seed', '--env-file', '/tmp/custom.env'));
    expect(parsed.envFiles).toEqual(['/tmp/custom.env']);
  });

  it('converts --timeout from seconds to milliseconds', () => {
    expect(parseArgs(argv('all', '--timeout', '300')).timeoutMs).toBe(300_000);
  });

  it('does not treat a flag value as the command', () => {
    // Regression guard: naive parsers pick up "/etc/tugpt/worker.env" as the command.
    const parsed = parseArgs(argv('--env-file', '/etc/tugpt/worker.env', 'inject'));
    expect(parsed.command).toBe('inject');
  });

  it('rejects a --timeout that is not a positive number', () => {
    expect(() => parseArgs(argv('all', '--timeout', 'abc'))).toThrow(/invalid --timeout/);
    expect(() => parseArgs(argv('all', '--timeout', '0'))).toThrow(/invalid --timeout/);
    expect(() => parseArgs(argv('all', '--timeout', '-5'))).toThrow(/invalid --timeout/);
  });

  it('rejects a trailing flag with no value', () => {
    expect(() => parseArgs(argv('all', '--env-file'))).toThrow(/--env-file requires a path/);
    expect(() => parseArgs(argv('all', '--timeout'))).toThrow(/--timeout requires a value/);
  });

  it('returns an empty command when none is supplied', () => {
    expect(parseArgs(argv()).command).toBe('');
  });
});

describe('parseEnvFile', () => {
  it('parses plain KEY=value lines', () => {
    expect(parseEnvFile('FOO=bar\nBAZ=qux')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('ignores comments and blank lines', () => {
    expect(parseEnvFile('# a comment\n\nFOO=bar\n   \n# another')).toEqual({ FOO: 'bar' });
  });

  it('strips an "export " prefix, as used in shell-sourced env files', () => {
    expect(parseEnvFile('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('strips matching surrounding quotes', () => {
    expect(parseEnvFile('A="bar"\nB=\'baz\'')).toEqual({ A: 'bar', B: 'baz' });
  });

  it('keeps unmatched quotes verbatim rather than corrupting the value', () => {
    expect(parseEnvFile('A="bar')).toEqual({ A: '"bar' });
  });

  it('keeps "=" characters inside the value, which base64 keys end with', () => {
    // Supabase JWTs and base64 secrets routinely contain '='.
    expect(parseEnvFile('KEY=abc=def==')).toEqual({ KEY: 'abc=def==' });
  });

  it('ignores malformed lines with no "=" and lines starting with "="', () => {
    expect(parseEnvFile('JUSTAKEY\n=novalue\nOK=1')).toEqual({ OK: '1' });
  });

  it('tolerates CRLF line endings', () => {
    expect(parseEnvFile('FOO=bar\r\nBAZ=qux\r\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  it('lets a later file override an earlier key when merged', () => {
    const first = parseEnvFile('SHARED=one');
    const second = parseEnvFile('SHARED=two');
    expect({ ...first, ...second }).toEqual({ SHARED: 'two' });
  });
});

describe('fingerprint', () => {
  it('never reveals a full secret', () => {
    const secret = 'super-secret-service-role-key-value';
    const printed = fingerprint(secret);
    expect(printed).not.toContain(secret);
    expect(printed).toContain('35 chars');
  });

  it('reveals nothing at all for short values', () => {
    expect(fingerprint('abc')).toBe('<set>');
  });
});

describe('harness constants are unmistakably synthetic', () => {
  it('uses a reserved .invalid TLD for the reviewer, which can never be a real inbox', () => {
    expect(REVIEWER_EMAIL.endsWith('.invalid')).toBe(true);
  });

  it('uses a provider phone id that cannot collide with a numeric Meta id', () => {
    expect(/^\d+$/.test(PROVIDER_PHONE_NUMBER_ID)).toBe(false);
    expect(PROVIDER_PHONE_NUMBER_ID).toContain('DO-NOT-USE');
  });

  it('uses non-dialable all-zero phone numbers', () => {
    expect(CONNECTION_PHONE).toMatch(/^\+0+$/);
    expect(CONTACT_PHONE).toMatch(/^\+0+1$/);
  });

  it('scopes the org slug so it reads as internal test data', () => {
    expect(ORG_SLUG).toBe('internal-e2e-test');
  });

  it('keeps the two phone numbers distinct', () => {
    expect(CONNECTION_PHONE).not.toBe(CONTACT_PHONE);
  });
});
