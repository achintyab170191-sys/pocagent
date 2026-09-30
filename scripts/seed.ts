import { migrate, seedStaticFixtures } from '@sbo/persistence';
import { connect } from './lib.js';

/**
 * db:seed — imports the STATIC reference fixtures (cases, mock utility results, decision rules, templates, register/CRM/financial/document
 * fixtures, country requirements, process catalog, reason codes) into the `source` schema with exact source column names.
 * It never imports exported runtime rows: the runtime tables stay empty (clean baseline). Historical runtime examples are opt-in via
 * `npm run import:sources -- --history`.
 */
const sql = connect();
try {
  await migrate(sql);
  const summaries = await seedStaticFixtures(sql, process.cwd());
  for (const entry of summaries) console.log(`source.${entry.table}: ${entry.rows} rows, ${entry.columns} columns`);
  const [runtime] = await sql<{ n: number }[]>`SELECT (SELECT count(*) FROM runtime_utility_results) + (SELECT count(*) FROM decisions) + (SELECT count(*) FROM runtime_cases) + (SELECT count(*) FROM audit_events) AS n`;
  console.log(`Clean runtime baseline: ${runtime?.n ?? 0} runtime rows present (seed does not create runtime state).`);
} finally { await sql.end(); }
