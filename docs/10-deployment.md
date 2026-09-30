# 10 · Deploying a demo URL

Goal: one public `https://…` address you can open from any laptop (no git, no install), protected by a shared password, running the synthetic data only.

The API image serves the built web app itself, so there is **one service and one URL**. In **demo mode** (`PERSISTENCE=memory`, `AGENT_RUNTIME=deterministic`) it needs no database and no model key: the registers and personas live in code, cases live in the process and reset when the service restarts.

## What was verified locally (no Docker on the authoring machine)

`npm run build` produces `dist/api/server.mjs` + `dist/web`. That bundle was started in production mode (`NODE_ENV=production`, in-memory, with a password) and driven over HTTP: password gate, page + assets + client routes (`/review`, `/operations`, `/status`), page CSP, `Secure`/`HttpOnly`/`SameSite=Strict` cookies, foreign-Origin refusal, and a full customer journey (partial company name → "Did you mean" → real PDF uploads read by the bundled document reader → APPROVE). `tests/deploy.test.ts` covers the same behaviours. **The Dockerfile and `render.yaml` themselves have not been executed** — the first deploy is their first run; read the platform build log once.

## Render (free plan) — about 10 minutes

1. Push this repository to GitHub (merge the branch that contains `render.yaml`).
2. Render dashboard → **New → Blueprint** → connect the repository → it reads `render.yaml`.
3. Enter **DEMO_PASSWORD** when asked (8+ characters; share it with whoever you demo to). Everything else is pre-filled (`SESSION_SECRET` is generated).
4. Deploy. When the log says the service is live, open `https://<service>.onrender.com`, enter any user name and the password, and check `https://<service>.onrender.com/health`.

`APP_BASE_URL` is taken from `RENDER_EXTERNAL_URL`, so no address has to be typed in. On the free plan the service sleeps after ~15 minutes without traffic (the first request takes ~30–60 s to wake it) and memory is cleared each time it restarts — open the URL a few minutes before the demo.

## Any other Docker host

```bash
docker build -t sbo-demo .
docker run -p 3000:3000 \
  -e NODE_ENV=production -e PERSISTENCE=memory -e AGENT_RUNTIME=deterministic \
  -e SESSION_SECRET=<32+ random characters> -e UPLOAD_DIR=/data/uploads \
  -e APP_BASE_URL=https://<your public address> -e DEMO_PASSWORD=<8+ characters> sbo-demo
```

`APP_BASE_URL` must be the exact public origin: requests from any other origin are refused (CSRF/CORS). Terminate TLS in front of the container (the platform does this) and set `TRUST_PROXY` to the proxy's address range so rate limits key on the real client.

## Durable deployment (Postgres) and the model

- Durable: `PERSISTENCE=postgres` (default) + `DATABASE_URL`. Tables are created on start; run `npm run db:seed` once for the reference fixtures (otherwise the archived CSVs are used).
- Model: `AGENT_RUNTIME=claude` + `ANTHROPIC_API_KEY` + `CLAUDE_MODEL` (never in the repository; use the platform's secret settings). The deterministic runtime produces the same governed outcomes.

## Security notes

- `DEMO_PASSWORD` is a shared secret (HTTP Basic), **not** user management: the review dashboard, reopen and status endpoints are otherwise unauthenticated (docs/security-review.md SEC-06). Keep it on for any public URL; change it or delete the service after the demo.
- Everything shown is synthetic; nothing is sent, and no production system is read or written.
- Uploads are stored on the container's disk (`UPLOAD_DIR`) and disappear on redeploy.