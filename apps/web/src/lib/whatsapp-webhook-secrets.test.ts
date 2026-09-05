/**
 * @file whatsapp-webhook-secrets.test.ts
 * @description The two states that matter are "present" and "not usable", and
 * the second one has three spellings. Everything here is about which of them
 * a caller is told.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readSecret, reportMissingSecret } from './whatsapp-webhook-secrets';

describe('readSecret', () => {
  it('accepts a real value', () => {
    const result = readSecret('WHATSAPP_APP_SECRET', 'a-real-secret');
    expect(result).toEqual({ ok: true, value: 'a-real-secret' });
  });

  it('refuses an unset variable', () => {
    const result = readSecret('WHATSAPP_APP_SECRET', undefined);
    expect(result.ok).toBe(false);
  });

  it('refuses an empty variable', () => {
    // `FOO=` in an env file. The old code turned this into a usable value.
    const result = readSecret('WHATSAPP_APP_SECRET', '');
    expect(result.ok).toBe(false);
  });

  it('refuses a whitespace-only variable', () => {
    // `FOO="   "`, or a here-doc that kept its indentation. Nobody configures
    // this on purpose, and treating it as a secret means the endpoint accepts
    // whatever an attacker can also type.
    expect(readSecret('WHATSAPP_APP_SECRET', '   ').ok).toBe(false);
    expect(readSecret('WHATSAPP_APP_SECRET', '\n').ok).toBe(false);
    expect(readSecret('WHATSAPP_APP_SECRET', '\t \n').ok).toBe(false);
  });

  it('does not trim a value that has one', () => {
    // Deliberate. Trimming would make the endpoint accept a token Meta will
    // never send, and the resulting "verification keeps failing" would be
    // blamed on Meta rather than on the stray space in the env file.
    const result = readSecret('WHATSAPP_VERIFY_TOKEN', ' padded ');
    expect(result).toEqual({ ok: true, value: ' padded ' });
  });

  it('names the variable in the reason, and distinguishes unset from empty', () => {
    // The operator reading the log has two different things to do: add the
    // line, or fill it in. A single "missing" for both would send them to look
    // at a line that is already there.
    const unset = readSecret('WHATSAPP_VERIFY_TOKEN', undefined);
    const empty = readSecret('WHATSAPP_VERIFY_TOKEN', '');

    expect(unset.ok || empty.ok).toBe(false);
    if (unset.ok || empty.ok) throw new Error('unreachable');

    expect(unset.reason).toContain('WHATSAPP_VERIFY_TOKEN');
    expect(empty.reason).toContain('WHATSAPP_VERIFY_TOKEN');
    expect(unset.reason).not.toBe(empty.reason);
  });
});

describe('reportMissingSecret', () => {
  afterEach(() => vi.restoreAllMocks());

  it('says which variable is missing and what to do', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportMissingSecret('WHATSAPP_APP_SECRET is not set');

    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain('WHATSAPP_APP_SECRET');
    expect(line).toContain('web.env');
  });

  it('logs every time rather than once per process', () => {
    // A deliberate choice, and one worth a test because "log once" is the
    // instinctive optimisation. It needs module-level state, which persists
    // across tests and would make the guard depend on execution order. The
    // failure this line exists to surface is an endpoint silently rejecting
    // every real delivery; repetition is the point.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    reportMissingSecret('WHATSAPP_APP_SECRET is not set');
    reportMissingSecret('WHATSAPP_APP_SECRET is not set');
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
