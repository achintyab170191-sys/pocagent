import { createPostgresRepository, loadSourceDataFromDb } from '@sbo/persistence';
import { connect, flag } from './lib.js';

/**
 * reset:runtime — deletes ONLY runtime state (utility results, runtime cases, decisions, evidence requests/evidence, reviews,
 * communications, audit events, chat sessions). Static fixtures (`source` schema), decision rules, templates and migrations are untouched.
 */
if (process.env.NODE_ENV === 'production' && !flag('--yes')) { console.error('Refusing to reset runtime state with NODE_ENV=production without --yes.'); process.exit(1); }
const sql = connect();
try {
  const source = await loadSourceDataFromDb(sql);
  const repository = createPostgresRepository(process.env.DATABASE_URL ?? '', source, { max: 1 });
  const tables = ['runtime_utility_results', 'runtime_cases', 'decisions', 'evidence_requests', 'case_evidence', 'human_reviews', 'communications', 'audit_events', 'chat_sessions'];
  const before = await Promise.all(tables.map(async (table) => [table, (await sql.unsafe(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n as number] as const));
  await repository.resetRuntime();
  await repository.close();
  for (const [table, count] of before) console.log(`${table}: ${count} → 0`);
  console.log('Runtime state cleared. Source fixtures and decision rules were not modified.');
} finally { await sql.end(); }
