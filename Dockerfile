# API image (bundle produced by `npm run build`). Not built on the authoring machine (no Docker available there).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages packages
RUN npm ci
COPY . .
RUN node scripts/build-api.mjs

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/dist ./dist
# Preserved source exports: the fallback path reads the CSV fixtures if the database has not been seeded.
COPY --from=build /app/dt_*.csv ./
RUN npm ci --omit=dev --workspaces=false || npm ci --omit=dev
USER node
EXPOSE 3000
CMD ["node", "dist/api/server.mjs"]
