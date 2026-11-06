# syntax=docker/dockerfile:1

# ---- build: compile the server and bundle the web app -------------------------------
# glibc base: the web toolchain (Vite, its native bundler) ships prebuilt glibc binaries.
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm npm ci
COPY server server
COPY web web
RUN npm run build

# ---- deps: production dependencies of the server only ------------------------------
FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --workspace server --include-workspace-root=false

# ---- runtime-base: what every image below shares -------------------------------------
FROM node:24-alpine AS runtime-base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/server/package.json server/
USER node

# ---- stub: the fixture data source, for local runs and tests only --------------------
FROM runtime-base AS stub
ENV PORT=4002
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/fixtures server/fixtures
EXPOSE 4002
HEALTHCHECK --interval=2s --timeout=3s --retries=15 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "--enable-source-maps", "server/dist/stub/server.js"]

# ---- app-dist: the compiled server without the stub ----------------------------------
FROM build AS app-dist
RUN rm -rf server/dist/stub

# ---- app (default target): API, UI, loops; `server/dist/db/migrate.js` for migrations --
FROM runtime-base AS app
ENV PORT=3000
COPY --from=app-dist /app/server/dist server/dist
COPY --from=build /app/server/drizzle server/drizzle
COPY --from=build /app/web/dist web/dist
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --retries=10 --start-period=5s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/livez`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
# SIGTERM drains the poll and summary loops before exit.
CMD ["node", "--enable-source-maps", "server/dist/main.js"]
