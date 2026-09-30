/**
 * Source importers and DB bootstrap.
 *  - `source.<table>`   raw import tables for the STATIC reference fixtures (exact source column names/casing, all TEXT, so the CSV round-trips
 *                       byte-for-byte; typed domain objects are produced by buildSourceData()).
 *  - `history.<table>`  raw import of the exported RUNTIME rows. Reference only: never read by the application and never seeded into the
 *                       clean runtime baseline.
 *  - migrations         create the empty runtime tables (the clean runtime baseline).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Sql } from 'postgres';
import { buildSourceData, historicalRuntimeTables, readCsvTable, staticFixtureTables, type CsvRecord, type SourceData } from './index.js';

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const identifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export async function migrate(sql: Sql): Promise<string[]> {
  await sql.unsafe('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const applied = new Set((await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((row) => row.name));
  const newlyApplied: string[] = [];
  for (const file of readdirSync(migrationsDirectory).filter((name) => name.endsWith('.sql')).sort()) {
    if (applied.has(file)) continue;
    await sql.begin(async (transaction) => {
      await transaction.unsafe(readFileSync(join(migrationsDirectory, file), 'utf8'));
      await transaction`INSERT INTO schema_migrations (name) VALUES (${file})`;
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}

export interface ImportSummary { schema: string; table: string; rows: number; columns: number; }

/** Creates `<schema>.<table>` with the exact CSV header names as TEXT columns and replaces its contents. */
export async function importRawTable(sql: Sql, schema: string, table: string, root: string): Promise<ImportSummary> {
  const { headers, rows } = readCsvTable(root, table);
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${identifier(schema)}`);
  const target = `${identifier(schema)}.${identifier(table)}`;
  await sql.unsafe(`DROP TABLE IF EXISTS ${target}`);
  await sql.unsafe(`CREATE TABLE ${target} (_row_number INTEGER PRIMARY KEY, ${headers.map((header) => `${identifier(header)} TEXT`).join(', ')})`);
  await sql.begin(async (transaction) => {
    for (const [index, row] of rows.entries()) {
      const values = headers.map((header) => row[header] ?? '');
      await transaction.unsafe(`INSERT INTO ${target} (_row_number, ${headers.map(identifier).join(', ')}) VALUES ($1, ${headers.map((_, position) => `$${position + 2}`).join(', ')})`, [index + 1, ...values]);
    }
  });
  return { schema, table, rows: rows.length, columns: headers.length };
}

/** db:seed — static reference fixtures only. Idempotent. Leaves runtime tables untouched. */
export async function seedStaticFixtures(sql: Sql, root: string): Promise<ImportSummary[]> {
  const summaries: ImportSummary[] = [];
  for (const table of staticFixtureTables) summaries.push(await importRawTable(sql, 'source', table, root));
  return summaries;
}

/** import:sources --history — exported runtime rows into `history` for inspection. Never used by the app. */
export async function importHistoricalRuntime(sql: Sql, root: string): Promise<ImportSummary[]> {
  const summaries: ImportSummary[] = [];
  for (const table of historicalRuntimeTables) summaries.push(await importRawTable(sql, 'history', table, root));
  return summaries;
}

/** Reads the seeded `source` schema back into the typed domain adapter (throws if the database has not been seeded). */
export async function loadSourceDataFromDb(sql: Sql): Promise<SourceData> {
  const present = await sql<{ table_name: string }[]>`SELECT table_name FROM information_schema.tables WHERE table_schema = 'source'`;
  const names = new Set(present.map((row) => row.table_name));
  const missing = staticFixtureTables.filter((table) => !names.has(table));
  if (missing.length > 0) throw new Error(`Database is not seeded (missing source tables: ${missing.join(', ')}). Run npm run db:seed.`);
  const tables = new Map<string, CsvRecord[]>();
  for (const table of staticFixtureTables) {
    const rows = await sql.unsafe(`SELECT * FROM ${identifier('source')}.${identifier(table)} ORDER BY _row_number`);
    tables.set(table, rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => key !== '_row_number').map(([key, value]) => [key, String(value ?? '')]))));
  }
  return buildSourceData(tables);
}
