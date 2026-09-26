/** Minimal logger so library code never writes to console directly. */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export function consoleLogger(verbose = false): Logger {
  return {
    debug: (m) => {
      if (verbose) console.error(`[debug] ${m}`);
    },
    info: (m) => console.error(`[info] ${m}`),
    warn: (m) => console.error(`[warn] ${m}`),
    error: (m) => console.error(`[error] ${m}`),
  };
}

/** No-op logger for tests and library embedding. */
export function silentLogger(): Logger {
  const noop = () => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}
