import { importHistoricalRuntime, migrate, seedStaticFixtures } from '@sbo/persistence';
import { connect, flag } from './lib.js';
import { verifySources } from './verify-sources.js';

/**
 * import:sources — reads the preserved source exports (CSV data tables) into raw import tables with their exact column names.
 *   --history   also import the exported runtime rows into schema `history` (reference only; never used by the application)
 *   --verify    first verify the source files against artifacts/source-checksums.json (fails on any change)
 * Only CSV exports are present in the upload; JSON/XLSX table exports would be added as further readers of the same raw-table contract.
 */
if (flag('--verify')) {
  const problems = verifySources();
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log('Source files match artifacts/source-checksums.json.');
}
const sql = connect();
try {
  await migrate(sql);
  for (const entry of await seedStaticFixtures(sql, process.cwd())) console.log(`source.${entry.table}: ${entry.rows} rows`);
  if (flag('--history')) for (const entry of await importHistoricalRuntime(sql, process.cwd())) console.log(`history.${entry.table}: ${entry.rows} rows (historical runtime, reference only)`);
} finally { await sql.end(); }
