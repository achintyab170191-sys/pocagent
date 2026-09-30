# One image, one URL: the API serves the built web app too. Build: `docker build -t sbo-demo .`  Run: see docs/10-deployment.md
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages packages
RUN npm ci
COPY . .
# API bundle (dist/api, dist/prompts, dist/migrations) + web app (apps/web/dist -> dist/web). The type check is skipped here: it runs in CI / before deploy.
RUN node scripts/build-api.mjs && npm --workspace @sbo/web run build && node scripts/copy-web.mjs
# Only runtime dependencies go into the final image.
RUN npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
# Preserved source exports: the Postgres path falls back to these CSV fixtures if the database has not been seeded.
COPY --from=build /app/dt_*.csv ./
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/api/server.mjs"]