// winston factory. Console: one line per event, "HH:mm:ss LEVEL [module] message key=value".
// File: rotating JSON under LOG_DIR for debugging. Secrets are redacted in both.
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

export type Logger = winston.Logger;

const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|password|secret|token|api[_-]?key|key|access[_-]?key|secret[_-]?key|momentum_token|steam_api_key|steamhistory_api_key|s3_secret_key|s3_access_key)$/i;
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/:@]+):([^\s/@]+)@/gi;
const QUERY_KEY = /([?&](?:key|token|api_key|apikey|access_token)=)[^&\s]+/gi;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g;
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;

export function redactString(s: string): string {
  return s
    .replace(URL_CREDENTIALS, '$1$2:***@')
    .replace(QUERY_KEY, '$1***')
    .replace(BEARER, '$1 ***')
    .replace(JWT, '***jwt***');
}

export function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (SECRET_KEYS.test(key)) return '***';
  if (typeof value === 'string') return redactString(value);
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (depth > 4) return '[deep]';
  if (Array.isArray(value)) return value.map((v) => redactValue('', v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(k, v, depth + 1);
    }
    return out;
  }
  return value;
}

const RESERVED = new Set(['level', 'message', 'timestamp', 'module', 'stack', 'splat']);

const redact = winston.format((info) => {
  const out = info as Record<string, unknown>;
  if (typeof out.message === 'string') out.message = redactString(out.message);
  for (const k of Object.keys(out)) {
    if (RESERVED.has(k)) continue;
    out[k] = redactValue(k, out[k]);
  }
  if (typeof out.stack === 'string') out.stack = redactString(out.stack);
  return info;
});

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') {
    return /[\s"=]/.test(v) || v.length === 0 ? JSON.stringify(v) : v;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  const s = JSON.stringify(v);
  return s.length > 200 ? s.slice(0, 197) + '...' : s;
}

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

const consoleLine = winston.format.printf((info) => {
  const d = new Date();
  const ts = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const level = String(info.level).toUpperCase().padEnd(5);
  const mod = typeof info.module === 'string' ? info.module : 'app';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(info)) {
    if (RESERVED.has(k) || k === 'module') continue;
    if (typeof k === 'symbol') continue;
    parts.push(`${k}=${formatValue(v)}`);
  }
  const kv = parts.length > 0 ? ' ' + parts.join(' ') : '';
  const stack =
    typeof info.stack === 'string' && (info.level === 'error' || info.level === 'debug')
      ? '\n' + info.stack
      : '';
  return `${ts} ${level} [${mod}] ${String(info.message)}${kv}${stack}`;
});

export interface LoggerOptions {
  level: string;
  dev: boolean;
  dir: string;
  file?: boolean;
}

let root: winston.Logger | undefined;

export function createRootLogger(opts: LoggerOptions): winston.Logger {
  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        redact(),
        ...(opts.dev ? [winston.format.colorize({ level: true })] : []),
        consoleLine,
      ),
    }),
  ];
  if (opts.file !== false) {
    transports.push(
      new DailyRotateFile({
        dirname: opts.dir,
        filename: 'momarchive-%DATE%.log',
        datePattern: 'YYYY-MM-DD',
        maxSize: '50m',
        maxFiles: '14d',
        zippedArchive: true,
        level: 'debug',
        format: winston.format.combine(
          redact(),
          winston.format.timestamp(),
          winston.format.errors({ stack: true }),
          winston.format.json(),
        ),
      }),
    );
  }
  root = winston.createLogger({
    level: opts.level,
    transports,
    exitOnError: false,
  });
  return root;
}

export function getLogger(module: string): winston.Logger {
  if (!root) {
    root = createRootLogger({
      level: process.env.LOG_LEVEL ?? 'info',
      dev: process.env.NODE_ENV === 'development',
      dir: process.env.LOG_DIR ?? 'logs',
      file: process.env.NODE_ENV !== 'test',
    });
  }
  return root.child({ module });
}

/** Short, stack free description of an error for info and warn level lines. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return redactString(`${e.name}: ${e.message}`);
  return redactString(String(e));
}
