import { existsSync, readFileSync } from 'node:fs';
import { createSqlClient } from '@sbo/persistence';

/** Minimal .env loader (no dependency): KEY=VALUE lines, `#` comments, optional quotes. Existing environment variables win. */
export function loadDotEnv(file = '.env'): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trim().startsWith('#')) continue;
    const [, key, raw] = match;
    if (key && process.env[key] === undefined) process.env[key] = (raw ?? '').replace(/^(['"])(.*)\1$/, '$2');
  }
}

export function connect(max = 2) {
  loadDotEnv();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required (see .env.example). Start PostgreSQL with `docker compose up -d postgres`.');
  return createSqlClient(url, { max });
}

export const flag = (name: string): boolean => process.argv.includes(name);
