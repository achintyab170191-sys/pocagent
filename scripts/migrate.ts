import { migrate } from '@sbo/persistence';
import { connect } from './lib.js';

const sql = connect();
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `Applied migrations: ${applied.join(', ')}` : 'Database is up to date (no pending migrations).');
} finally { await sql.end(); }
