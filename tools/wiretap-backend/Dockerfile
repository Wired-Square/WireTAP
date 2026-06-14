# Build context is the REPO ROOT (see docker-compose.yml) so the capture
# schema at tools/wiretap-server/init_schema.sql is available to include_str!.

# --- admin UI (static SPA served at /admin) ---
FROM node:22-bookworm-slim AS admin-ui
WORKDIR /ui
COPY tools/wiretap-backend/admin-ui/package.json tools/wiretap-backend/admin-ui/package-lock.json* ./
RUN npm install
COPY tools/wiretap-backend/admin-ui/ ./
RUN npm run build

# --- backend binary ---
FROM rust:1-bookworm AS build
WORKDIR /src
COPY tools/wiretap-server/init_schema.sql tools/wiretap-server/init_schema.sql
COPY tools/wiretap-backend/Cargo.toml tools/wiretap-backend/Cargo.lock* tools/wiretap-backend/
COPY tools/wiretap-backend/src tools/wiretap-backend/src
WORKDIR /src/tools/wiretap-backend
RUN cargo build --release

# --- runtime ---
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/tools/wiretap-backend/target/release/wiretap-backend /usr/local/bin/wiretap-backend
COPY --from=admin-ui /ui/dist /usr/share/wiretap-admin
EXPOSE 8423 9323
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
    CMD curl -fsS http://localhost:8423/v1/health || exit 1
ENTRYPOINT ["wiretap-backend"]
