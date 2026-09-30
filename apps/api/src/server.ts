import { ClaudeAgentRuntime, DeterministicAgentRuntime, type AgentRuntime } from '@sbo/agent-runtime';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryRepository, createPostgresRepository, createSqlClient, loadSourceData, loadSourceDataFromDb, migrate, type Repository } from '@sbo/persistence';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();

// Postgres: schema first (idempotent), then the static reference fixtures from the seeded `source` schema.
// If the database has not been seeded yet, fall back to the preserved CSV exports so the app still runs (loudly).
// Memory (PERSISTENCE=memory): a demo with no database; the registers live in code, cases live in the process and are lost on restart.
let repository: Repository;
if (env.PERSISTENCE === 'memory') {
  console.warn('PERSISTENCE=memory: cases are kept in memory and are lost on restart (demo mode).');
  repository = new InMemoryRepository();
} else {
  const admin = createSqlClient(env.DATABASE_URL ?? '', { max: 1 });
  let source;
  try {
    await migrate(admin);
    try { source = await loadSourceDataFromDb(admin); console.log('Reference fixtures loaded from the database (source schema).'); } catch (error) {
      console.warn(`${error instanceof Error ? error.message : String(error)} Falling back to the preserved CSV exports.`);
      source = loadSourceData(process.cwd());
    }
  } finally { await admin.end(); }
  repository = createPostgresRepository(env.DATABASE_URL ?? '', source);
}
const agentRuntime: AgentRuntime = env.AGENT_RUNTIME === 'claude'
  ? new ClaudeAgentRuntime({ model: env.CLAUDE_MODEL ?? '', apiKey: env.ANTHROPIC_API_KEY ?? '' })
  : new DeterministicAgentRuntime();
// The built web app is served by the API itself (one URL, no separate web host): dist/web next to dist/api/server.mjs, or WEB_DIR.
const webRoot = [env.WEB_DIR, resolve(dirname(fileURLToPath(import.meta.url)), '../web')].find((candidate) => candidate && existsSync(resolve(candidate, 'index.html')));
const app = await buildApp({ repository, agentRuntime, config: { appBaseUrl: env.APP_BASE_URL, sessionSecret: env.SESSION_SECRET, uploadDirectory: env.UPLOAD_DIR, secureCookies: env.NODE_ENV === 'production', trustProxy: env.TRUST_PROXY, webRoot, demoPassword: env.DEMO_PASSWORD } });
await app.listen({ port: env.PORT, host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => repository.close()); });
