import { describe, expect, it, vi } from 'vitest';
import { Logger, sanitizeValue } from '../src/logger';

describe('Structured JSON Logger & Secret Hygiene', () => {
  it('formats log messages as structured JSON', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger({ service: 'test-service' });

    logger.info('Test log event', { action: 'user_login' });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const outputRaw = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(outputRaw);

    expect(parsed.level).toBe('info');
    expect(parsed.message).toBe('Test log event');
    expect(parsed.context.service).toBe('test-service');
    expect(parsed.context.action).toBe('user_login');
    expect(parsed.timestamp).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('redacts sensitive keys from log context', () => {
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const logger = new Logger({ service: 'test-service' });

    logger.info('Sensitive event', {
      apiKey: 'sk-1234567890123456789012345',
      password: 'my-super-secret-password',
      token: 'jwt-access-token',
      nested: {
        authorization: 'Bearer secret-bearer-token',
      },
    });

    const outputRaw = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(outputRaw);

    expect(parsed.context.apiKey).toBe('[REDACTED]');
    expect(parsed.context.password).toBe('[REDACTED]');
    expect(parsed.context.token).toBe('[REDACTED]');
    expect(parsed.context.nested.authorization).toBe('[REDACTED]');

    consoleSpy.mockRestore();
  });

  it('redacts Bearer tokens and OpenAI style API keys in string values', () => {
    expect(sanitizeValue('header', 'Bearer secrettoken123')).toBe('Bearer [REDACTED]');
    expect(sanitizeValue('customKey', 'sk-proj-12345678901234567890')).toBe('[REDACTED]');
  });

  it('redacts inline Bearer tokens and API keys anywhere within string values', () => {
    expect(sanitizeValue('msg', 'Log event with Bearer xyz')).toBe('Log event with Bearer [REDACTED]');
    expect(
      sanitizeValue(
        'msg',
        'Request failed with Bearer secrettoken123 in authorization header'
      )
    ).toBe('Request failed with Bearer [REDACTED] in authorization header');
    expect(
      sanitizeValue(
        'msg',
        'Found API key sk-proj-12345678901234567890 in configuration'
      )
    ).toBe('Found API key [REDACTED] in configuration');
    expect(
      sanitizeValue('msg', 'Supabase key sbp_123456789012345678901234 in body')
    ).toBe('Supabase key [REDACTED] in body');
  });

  it('formats error logs with error name, message, and stack trace', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = new Logger();
    const testErr = new Error('Database connection lost');

    logger.error('Query failure', testErr, { queryId: 'q-100' });

    expect(consoleErrorSpy).toHaveBeenCalledOnce();
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0]);

    expect(parsed.level).toBe('error');
    expect(parsed.message).toBe('Query failure');
    expect(parsed.error.name).toBe('Error');
    expect(parsed.error.message).toBe('Database connection lost');
    expect(parsed.error.stack).toBeDefined();

    consoleErrorSpy.mockRestore();
  });
});
