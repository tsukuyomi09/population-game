# Production deployment

Worldrawing's initial production foundation targets one Linux VPS running Docker
Compose. It keeps the web and population runtimes separate so they can later be
moved or scaled independently without changing the public population API.

## Runtime structure

```text
reverse proxy / host port
    ↓
Next.js web container
    ↓ private backend network + bearer token
Python population container
    ↓
read-only host raster directory + persistent tile-index volume
```

Only the Next.js port is published. The population container is attached only to
Compose's internal `backend` network and has no host port mapping.

Both containers use `restart: unless-stopped`. Docker must be configured to start
at boot. The web container waits for the population `/ready` check before starting,
and both images define runtime health checks.

## Prerequisites

- Docker Engine with Docker Compose v2;
- enough local disk for the population rasters and generated tile index;
- compatible WorldPop files named `*_pop_2026_CN_100m_R2025A_v1.tif`;
- a reverse proxy providing HTTPS for the Next.js port in normal production use.

## Environment and data

Create the production environment file:

```sh
cp deploy/production.env.example .env.production
```

Set at minimum:

- `POPULATION_RASTER_HOST_PATH`: absolute host path containing the GeoTIFF files;
- `POPULATION_SERVICE_AUTH_TOKEN`: a long random value shared by both containers.

For example, generate a token with:

```sh
openssl rand -hex 32
```

The raster directory is mounted read-only at `/data/population`. Ensure directories
are searchable and files are readable by the container. Generated indexes live in
the `population-tile-index` Docker volume and survive container replacement.

Other production settings:

- `POPULATION_SERVICE_URL`: defaults to `http://population:8001` inside Compose;
- `POPULATION_SERVICE_TIMEOUT_MS`: Next.js request timeout, default `120000`;
- `POPULATION_SERVICE_WORKERS`: persistent engine instances, default `2`;
- `POPULATION_SERVICE_QUEUE_SIZE`: bounded waiting calculations, default `8`;
- `POPULATION_TILE_SIZE`: preaggregation tile size, default `512`;
- `WORLDRAWING_BIND_ADDRESS`: defaults to `127.0.0.1` for a host reverse proxy;
- `WORLDRAWING_HTTP_PORT`: defaults to `3000`.

The Compose definition sets `NODE_ENV=production`, `POPULATION_PROVIDER=local`,
container raster/index paths, and internal service bind settings directly.

## Start and operate

Build and start both services:

```sh
docker compose --env-file .env.production -f compose.production.yml up -d --build
```

Inspect status and logs:

```sh
docker compose --env-file .env.production -f compose.production.yml ps
docker compose --env-file .env.production -f compose.production.yml logs -f
```

Verify the web container through its host binding:

```sh
curl --fail http://127.0.0.1:3000/api/health
```

Apply an update by pulling the new source and rerunning the `up -d --build`
command. Compose replaces changed containers; the restart policies recover either
runtime after a process failure or Docker daemon restart.

The first population start may take longer when the tile index is absent or stale.
The service does not become ready until engine initialization completes.

## Local development

The existing `npm run dev`, local Python virtual environment, and `.env` workflow
remain unchanged. Production Compose files and environment values are opt-in.
