import pino, { type Logger } from 'pino';

export type { Logger } from 'pino';

/**
 * Structured diagnostic logger (stderr). Execution traces go through the
 * EventBus; this logger is for operator diagnostics. Credential-shaped fields
 * are censored by pino's redaction as a second line of defence.
 */
export function createLogger(level: string = process.env.LOOPSMITH_LOG_LEVEL ?? 'warn'): Logger {
  return pino(
    {
      level,
      base: { service: 'loopsmith' },
      redact: {
        paths: [
          'apiKey',
          '*.apiKey',
          'headers.authorization',
          '*.headers.authorization',
          'token',
          '*.token',
        ],
        censor: '[REDACTED]',
      },
    },
    pino.destination(2),
  );
}
