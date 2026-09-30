// Copies the built web app (apps/web/dist) next to the API bundle (dist/web) so the API serves both from one URL.
import { cpSync, existsSync, rmSync } from 'node:fs';

if (!existsSync('apps/web/dist/index.html')) throw new Error('apps/web/dist is missing: run the web build first');
rmSync('dist/web', { recursive: true, force: true });
cpSync('apps/web/dist', 'dist/web', { recursive: true });
console.log('Web app copied to dist/web (served by dist/api/server.mjs)');
