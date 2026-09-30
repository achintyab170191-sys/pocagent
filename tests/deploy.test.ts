import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp } from '../apps/api/src/app.js';
import { loadEnv } from '../apps/api/src/env.js';
import { newStore, ScriptedRuntime } from '@sbo/testkit';

const apps: FastifyInstance[] = [];
afterEach(async () => { while (apps.length) await apps.pop()!.close(); });

const secret = 'a-test-secret-that-is-at-least-32-chars-long';
const basic = (password: string): string => `Basic ${Buffer.from(`demo:${password}`).toString('base64')}`;

function webRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'sbo-web-'));
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/assets/app.js"></script>');
  writeFileSync(join(root, 'assets', 'app.js'), 'console.log("app")');
  return root;
}
async function start(options: { webRoot?: string; demoPassword?: string } = {}): Promise<FastifyInstance> {
  const app = await buildApp({ repository: newStore(), agentRuntime: new ScriptedRuntime(), config: { appBaseUrl: 'http://localhost:5173', sessionSecret: secret, uploadDirectory: mkdtempSync(join(tmpdir(), 'sbo-up-')), ...options } });
  apps.push(app);
  return app;
}

describe('one-URL deployment: the API serves the built web app', () => {
  it('serves the page, its assets and index.html for client-side routes, with a page CSP; /api stays JSON with the locked-down CSP', async () => {
    const app = await start({ webRoot: webRoot() });
    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<div id="root">');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers['content-type']).toContain('javascript');
    for (const route of ['/review', '/operations', '/status']) {
      const routed = await app.inject({ method: 'GET', url: route });
      expect(routed.statusCode, route).toBe(200);
      expect(routed.body, route).toContain('<div id="root">');
    }
    const missing = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.headers['content-type']).toContain('json');
    expect(missing.headers['content-security-policy']).toContain("default-src 'none'");
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({ status: 'ok' });
    const posted = await app.inject({ method: 'POST', url: '/somewhere' });
    expect(posted.statusCode).toBeGreaterThanOrEqual(400); // only GET falls back to the page
    expect(posted.body).not.toContain('<div id="root">');
  });

  it('without a web root the API serves no pages (development: Vite serves them)', async () => {
    const app = await start();
    expect((await app.inject({ method: 'GET', url: '/' })).statusCode).toBe(404);
  });
});

describe('demo password (a shared demo URL)', () => {
  it('everything except /health asks for the password; a wrong password is refused; the right one gets in', async () => {
    const app = await start({ webRoot: webRoot(), demoPassword: 'demo-pass-123' });
    const anonymous = await app.inject({ method: 'GET', url: '/' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.headers['www-authenticate']).toContain('Basic');
    expect((await app.inject({ method: 'GET', url: '/api/session' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/reviews' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/', headers: { authorization: basic('wrong-password') } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/', headers: { authorization: 'Bearer demo-pass-123' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const ok = await app.inject({ method: 'GET', url: '/', headers: { authorization: basic('demo-pass-123') } });
    expect(ok.statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/api/reviews', headers: { authorization: basic('demo-pass-123') } })).statusCode).toBe(200);
  });

  it('without a demo password nothing is asked for', async () => {
    const app = await start({ webRoot: webRoot() });
    expect((await app.inject({ method: 'GET', url: '/api/reviews' })).statusCode).toBe(200);
  });
});

describe('deployment environment', () => {
  const base = { SESSION_SECRET: secret, UPLOAD_DIR: '/tmp/uploads', AGENT_RUNTIME: 'deterministic' };
  it('memory persistence needs no DATABASE_URL; postgres still requires it', () => {
    expect(loadEnv({ ...base, APP_BASE_URL: 'https://demo.example.com', PERSISTENCE: 'memory' })).toMatchObject({ PERSISTENCE: 'memory' });
    expect(() => loadEnv({ ...base, APP_BASE_URL: 'https://demo.example.com' })).toThrow('DATABASE_URL is required');
    expect(loadEnv({ ...base, APP_BASE_URL: 'https://demo.example.com', DATABASE_URL: 'postgres://x' })).toMatchObject({ PERSISTENCE: 'postgres' });
  });
  it('the host-provided public address (RENDER_EXTERNAL_URL) stands in for APP_BASE_URL; an explicit APP_BASE_URL wins', () => {
    expect(loadEnv({ ...base, PERSISTENCE: 'memory', RENDER_EXTERNAL_URL: 'https://sbo-demo.onrender.com' }).APP_BASE_URL).toBe('https://sbo-demo.onrender.com');
    expect(loadEnv({ ...base, PERSISTENCE: 'memory', APP_BASE_URL: 'https://custom.example.com', RENDER_EXTERNAL_URL: 'https://sbo-demo.onrender.com' }).APP_BASE_URL).toBe('https://custom.example.com');
    expect(() => loadEnv({ ...base, PERSISTENCE: 'memory' })).toThrow('APP_BASE_URL');
  });
  it('a demo password must be at least 8 characters', () => {
    expect(() => loadEnv({ ...base, PERSISTENCE: 'memory', APP_BASE_URL: 'https://d.example.com', DEMO_PASSWORD: 'short' })).toThrow('DEMO_PASSWORD');
    expect(loadEnv({ ...base, PERSISTENCE: 'memory', APP_BASE_URL: 'https://d.example.com', DEMO_PASSWORD: 'long-enough-1' }).DEMO_PASSWORD).toBe('long-enough-1');
  });
});
