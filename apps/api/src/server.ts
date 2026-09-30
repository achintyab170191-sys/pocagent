import { ClaudeAgentRuntime, DeterministicAgentRuntime, type AgentRuntime } from '@sbo/agent-runtime';
import { createPostgresRepository, createSqlClient, loadSourceData, loadSourceDataFromDb, migrate } from '@sbo/persistence';
import { buildApp } from './app.js';
import { loadEnv } from './env.js';

const env = loadEnv();

// Schema first (idempotent), then the static reference fixtures from the seeded `source` schema.
// If the database has not been seeded yet, fall back to the preserved CSV exports so the app still runs (loudly).
const admin = createSqlClient(env.DATABASE_URL, { max: 1 });
let source;
try {
  await migrate(admin);
  try { source = await loadSourceDataFromDb(admin); console.log('Reference fixtures loaded from the database (source schema).'); } catch (error) {
    console.warn(`${error instanceof Error ? error.message : String(error)} Falling back to the preserved CSV exports.`);
    source = loadSourceData(process.cwd());
  }
} finally { await admin.end(); }

const repository = createPostgresRepository(env.DATABASE_URL, source);
const agentRuntime: AgentRuntime = env.AGENT_RUNTIME === 'claude'
  ? new ClaudeAgentRuntime({ model: env.CLAUDE_MODEL ?? '', apiKey: env.ANTHROPIC_API_KEY ?? '' })
  : new DeterministicAgentRuntime();
const app = await buildApp({ repository, agentRuntime, config: { appBaseUrl: env.APP_BASE_URL, sessionSecret: env.SESSION_SECRET, uploadDirectory: env.UPLOAD_DIR, secureCookies: env.NODE_ENV === 'production', trustProxy: env.TRUST_PROXY } });
await app.listen({ port: env.PORT, host: '0.0.0.0' });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void app.close().then(() => repository.close()); });
