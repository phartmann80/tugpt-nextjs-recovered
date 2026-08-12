export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  requestId?: string;
  organizationId?: string;
  userId?: string;
  provider?: string;
  action?: string;
  [key: string]: unknown;
}

export interface StructuredLogMessage {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
}

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /authorization/i,
  /api[-_]?key/i,
  /cookie/i,
  /private[-_]?key/i,
  /service[-_]?role[-_]?key/i,
  /credential/i,
];

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function sanitizeValue(key: string, value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof key === 'string' && isSensitiveKey(key)) {
    return '[REDACTED]';
  }

  if (typeof value === 'string') {
    let sanitized = value;
    sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9-_.=]+/gi, 'Bearer [REDACTED]');
    sanitized = sanitized.replace(/sk-[A-Za-z0-9_-]{20,}|sbp_[A-Za-z0-9_-]{20,}/gi, '[REDACTED]');
    return sanitized;
  }

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(key, v));
  }

  if (typeof value === 'object') {
    const sanitizedObj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      sanitizedObj[k] = sanitizeValue(k, v);
    }
    return sanitizedObj;
  }

  return value;
}

export class Logger {
  private defaultContext: LogContext;

  constructor(defaultContext: LogContext = {}) {
    this.defaultContext = defaultContext;
  }

  private log(level: LogLevel, message: string, context?: LogContext, err?: Error): void {
    const rawContext = { ...this.defaultContext, ...context };
    const sanitizedContext = sanitizeValue('root', rawContext) as LogContext;

    const payload: StructuredLogMessage = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: sanitizedContext,
    };

    if (err) {
      payload.error = {
        name: err.name,
        message: sanitizeValue('message', err.message) as string,
        stack: err.stack,
      };
    }

    const jsonOutput = JSON.stringify(payload);

    switch (level) {
      case 'error':
        console.error(jsonOutput);
        break;
      case 'warn':
        console.warn(jsonOutput);
        break;
      case 'info':
      case 'debug':
      default:
        console.log(jsonOutput);
        break;
    }
  }

  debug(message: string, context?: LogContext): void {
    this.log('debug', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('info', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('warn', message, context);
  }

  error(message: string, err?: Error, context?: LogContext): void {
    this.log('error', message, context, err);
  }

  child(additionalContext: LogContext): Logger {
    return new Logger({ ...this.defaultContext, ...additionalContext });
  }
}

export const defaultLogger = new Logger({ service: 'tugpt-platform' });