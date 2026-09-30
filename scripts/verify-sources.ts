import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

interface ChecksumEntry { path?: string; file?: string; sha256: string; }

/** Phase-0 preservation check: every source artifact must still hash to the value recorded in artifacts/source-checksums.json. */
export function verifySources(manifestPath = 'artifacts/source-checksums.json'): string[] {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  const entries: ChecksumEntry[] = Array.isArray(raw) ? raw as ChecksumEntry[] : Object.entries((raw as { files?: Record<string, string> }).files ?? raw as Record<string, string>).map(([path, sha256]) => ({ path, sha256: String(sha256) }));
  const problems: string[] = [];
  for (const entry of entries) {
    const file = entry.path ?? entry.file ?? '';
    if (!file) continue;
    if (!existsSync(file)) { problems.push(`MISSING ${file}`); continue; }
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex');
    if (actual !== entry.sha256) problems.push(`CHANGED ${file}`);
  }
  if (entries.length === 0) problems.push(`No entries found in ${manifestPath}`);
  return problems;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const problems = verifySources();
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('All source artifacts match the preservation checksum manifest.');
}
