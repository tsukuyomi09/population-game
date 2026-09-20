# Railway deployment

This maps the existing production architecture to two Railway services in one
project and environment:

```text
internet
    -> web (public Railway/custom domain)
    -> http://population.railway.internal:8001 + bearer token
    -> population (private only)
    -> Railway volume at /data/population
```

Railway does not run the Compose file directly. The Compose setup remains the
local/VPS production path; Railway builds the same `deploy/web.Dockerfile` and
`deploy/population.Dockerfile` as two separate services.

## 1. Create the services

1. Create an empty Railway project and use one environment (normally
   `production`).
2. Add the GitHub repository twice from the branch being deployed.
3. Name the services exactly `population` and `web` so the checked-in reference
   variables resolve without edits. Leave Root Directory at the repository root.
4. In each service's Variables raw editor, paste its template:
   - population: `deploy/railway.population.env.example`
   - web: `deploy/railway.web.env.example`
5. Replace `POPULATION_SERVICE_AUTH_TOKEN` on `population` with a long random
   secret, for example from `openssl rand -hex 32`, and seal it. The `web`
   service reads the same value through a Railway reference variable.

`RAILWAY_DOCKERFILE_PATH` selects the existing production Dockerfile. Both
services use a fixed `PORT` so Railway health checks and the Docker image health
checks target the same listener.

## 2. Attach and populate storage

Railway currently permits one volume per service, so attach one volume named
`population-data` to `population` at:

```text
/data/population
```

Use this volume layout:

```text
/data/population/
  rasters/
    *_pop_2026_CN_100m_R2025A_v1.tif
  tile-index/
    population-tiles-512.json.gz
```

The raster files must be directly inside `rasters/`. Upload the existing data
with the Railway CLI after `railway login` and `railway link`:

```sh
railway volume files --volume population-data upload ./data/population /rasters
railway volume files --volume population-data upload ./artifacts/population/tile-index /tile-index
railway volume files --volume population-data list /rasters
railway volume files --volume population-data list /tile-index
```

Uploading the generated index is optional. The engine validates it against
raster filenames, sizes, and modification times. If an upload changes a raster
timestamp, startup safely rebuilds the index into `tile-index`; that rebuilt
index persists on the volume.

Railway volumes mount as root while the production image normally runs as UID
10001. `RAILWAY_RUN_UID=0` is therefore required for the service to create or
refresh its index. Do not attach this volume to `web`.

## 3. Networking and health

Configure the service settings as follows:

| Service | Public networking | Health path | Timeout | Restart policy |
| --- | --- | --- | --- | --- |
| `population` | None: no domain and no TCP proxy | `/ready` | 900 seconds | Always |
| `web` | Generate a Railway domain or add the production domain | `/api/health` | 300 seconds | Always |

Private networking is automatic inside a Railway project/environment. The web
URL uses the `population` service's `RAILWAY_PRIVATE_DOMAIN` reference and plain
HTTP on port 8001; it is not reachable from browsers or the public internet.
Bearer authentication remains required for `/v1/calculate`.

The long population health timeout allows first boot to build a missing or stale
tile index. Railway health checks gate a deployment but are not continuous
runtime monitoring. The Dockerfiles retain their own health checks, and the
Railway restart policy handles process exits.

## 4. Deploy and verify

Deploy `population` first. Wait for `/ready` to pass and confirm its logs report
the expected raster count and engine pool. Then deploy `web` and generate its
public domain.

Verify:

```sh
curl --fail https://<web-domain>/api/health
curl --fail --request POST https://<web-domain>/api/population \
  --header 'Content-Type: application/json' \
  --data '{"targetPopulation":1000000,"shapes":[{"id":"railway-smoke","geometry":{"type":"Polygon","coordinates":[[[12.45,41.85],[12.55,41.85],[12.55,41.95],[12.45,41.95],[12.45,41.85]]]}}]}'
```

Do not add a public domain or TCP proxy to `population`. A direct public request
to that service should therefore be impossible; all calculation traffic must
pass through the public Next.js route.

## Required variables

`web` requires `PORT`, `POPULATION_PROVIDER`, `POPULATION_SERVICE_URL`,
`POPULATION_SERVICE_AUTH_TOKEN`, and `POPULATION_SERVICE_TIMEOUT_MS`.

`population` requires both path variables, host/port, worker and queue settings,
the shared auth token, and the three Railway settings in its template. The
checked-in defaults preserve the current production behavior: two engines, an
eight-request waiting queue, 512-pixel tiles, a one-second saturation retry, and
a 1 MB request limit.

## Railway limitations

- The current eight-country raster set is about 585 MB, which exceeds Railway's
  0.5 GB Free/Trial volume allowance. Use a plan/volume large enough for the
  current dataset, indexes, and growth; global coverage will require materially
  more storage.
- A service with a Railway volume cannot use replicas and has brief downtime
  during redeploys. Separating or horizontally scaling the population service
  later will require replicated data or remote raster storage, which is outside
  this deployment step.
- Railway has no Compose `depends_on` equivalent. The public API already returns
  its existing provider error while population is unavailable; deploy and verify
  `population` before `web` for the initial release.
