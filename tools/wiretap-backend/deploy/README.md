# Deploying the WireTAP Backend

This directory holds a **portable production** deployment — a Docker Compose
stack that references a *prebuilt* `wiretap-backend` image, so it runs on any
Docker host: a generic NAS, a VM, or a TrueNAS SCALE **Custom App**. (The
[../docker-compose.yml](../docker-compose.yml) one level up *builds* the image
and is meant for development.)

Two services: TimescaleDB (Postgres, not published) and the backend gateway
(HTTP API + admin UI on 8423, binary ingest on 9323). Database backups are
left to the host — on TrueNAS, a ZFS snapshot task on the data dataset.

## 1. Build and distribute the image

TrueNAS (and most NAS app systems) install from a prebuilt image, not a
Dockerfile. Pick one:

**A. Build natively on the target host** (no registry; what we use for the NAS).
Copy the build context (the `tools/wiretap-backend/` tree + the shared schema
file) to the host and build there:
```bash
# from a checkout on the host, repo root:
docker build -f tools/wiretap-backend/Dockerfile -t wiretap-backend:latest .
```
The build context must contain `tools/wiretap-backend/` and `tools/wiretap-server/init_schema.sql`
(the Dockerfile `include_str!`s the schema), so build from the repo root.

**B. Build elsewhere, copy the image** (no registry, cross-machine). Build for
the target's architecture, then stream it over SSH:
```bash
docker build --platform linux/amd64 -f tools/wiretap-backend/Dockerfile -t wiretap-backend:latest .
docker save wiretap-backend:latest | ssh root@nas 'docker load'
```
(Apple Silicon must pass `--platform linux/amd64` for an x86_64 NAS.)

**C. Registry.** Push to GHCR/Docker Hub and set `WIRETAP_IMAGE` to the pulled
tag. Best for fleets/CI; needs the package public or a pull credential on the host.

## 2. Generic Docker host

```bash
cp .env.example .env          # set POSTGRES_PASSWORD, WIRETAP_ADMIN_KEY, WIRETAP_DATA
docker compose up -d
curl -fsS http://localhost:8423/v1/health
```

## 3. TrueNAS SCALE (24.10+ / 25.04) Custom App

1. **Create a dataset** for the database (Datasets → Add Dataset), e.g.
   `main-ssd/applications/wiretap-backend` — an SSD pool is ideal for Postgres.
   Note its mountpoint (`/mnt/main-ssd/applications/wiretap-backend`).
2. **Load the image** onto the NAS (method A or B above). Confirm with
   `docker images | grep wiretap-backend`.
3. **Apps → Discover Apps → Custom App → Install via YAML**, and paste the
   compose below, editing the two `CHANGE_ME` values and the dataset path.
   `openssl rand -hex 32` makes a good admin key.

```yaml
services:
  timescaledb:
    image: timescale/timescaledb:latest-pg16
    environment:
      POSTGRES_PASSWORD: CHANGE_ME
    command: postgres -c shared_preload_libraries=timescaledb
    volumes:
      - /mnt/main-ssd/applications/wiretap-backend/pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      timeout: 3s
      retries: 24
    restart: unless-stopped

  backend:
    image: wiretap-backend:latest
    environment:
      POSTGRES_PASSWORD: CHANGE_ME
      WIRETAP_ADMIN_KEY: CHANGE_ME_admin_key
      WIRETAP_PG_HOST: timescaledb
      WIRETAP_DEFAULT_DB: wiretap
      WIRETAP_AUTO_CREATE: "true"
    ports:
      - "8423:8423"
      - "9323:9323"
    depends_on:
      timescaledb:
        condition: service_healthy
    restart: unless-stopped
```

4. **Deploy.** When it's running, browse to `http://nas.gou.wiredsquare.com:8423/admin`
   and sign in with the admin key, or `curl http://nas...:8423/v1/health`.
5. **Backups** — Data Protection → Periodic Snapshot Tasks on
   `main-ssd/wiretap` (e.g. hourly, keep 2 weeks). That snapshots the Postgres
   data dir; replicate the snapshots to another pool/host for off-box safety.

Notes:
- The container's Postgres runs as uid 999 and chowns its data dir on first
  init, so a fresh empty dataset is fine.
- Image upgrades: rebuild/reload `wiretap-backend:latest`, then Apps → the app →
  Edit → Update (or redeploy). The schema is idempotent; data on the dataset
  persists across container replacement.

## 4. After install

- **Desktop**: Settings → Data I/O → add a *WireTAP Backend* profile with URL
  `http://nas.gou.wiredsquare.com:8423`, the API key, and a database name.
  Create per-user `read` keys in the admin UI rather than sharing the admin key.
- **Capture devices / Pi forward mode**: point them at `nas...:9323` with an
  `ingest` key (admin UI → Keys).
- **Migrate an existing archive** into the NAS database: see the runbook in
  [../README.md](../README.md#migrating-an-existing-archive-into-the-container)
  and [tools/wiretap-server/migrate_to_timescale.py](../../wiretap-server/migrate_to_timescale.py).
