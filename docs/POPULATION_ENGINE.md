# Worldrawing — Population Engine

**Status:** validated local multi-raster engine

**Dataset:** WorldPop Global2 R2025A v1, 2026, constrained population count, ~100 m

**Last updated:** 2026-09-20

## Purpose

Worldrawing needs to calculate the population contained inside one or more player-drawn geographic shapes.

The population engine is designed around the needs of the game:

- no runtime dependency on external population APIs;
- support for very large selections;
- support for multiple independent shapes;
- support for shapes crossing country boundaries;
- stable and deterministic results;
- accuracy appropriate to gameplay rather than unnecessary GIS precision;
- low enough latency for a round submission to feel immediate.

The public population response remains independent from the underlying calculation provider.

## Public contract

The frontend submits closed GeoJSON `Polygon` geometries with stable shape IDs.

Conceptually:

```json
{
  "targetPopulation": 50000000,
  "shapes": [
    {
      "id": "shape-id",
      "geometry": {
        "type": "Polygon",
        "coordinates": []
      }
    }
  ]
}
```

The response remains:

```json
{
  "results": [
    {
      "id": "shape-id",
      "population": 12345.67
    }
  ],
  "totalPopulation": 12345.67
}
```

`targetPopulation` is used only to choose the calculation strategy. It does not alter scoring or population values directly.

## Providers

The population boundary supports two providers:

### WorldPop provider

The original implementation calls the external WorldPop API.

It remains available as a reference/fallback development provider, but it is no longer the intended production calculation path because the external API has area limits, quotas, network latency, asynchronous jobs, and polling.

### Local raster provider

The local provider calculates population directly from WorldPop GeoTIFF files available to the server.

This is the intended engine for Worldrawing.

Provider selection is controlled through environment configuration.

```text
POPULATION_PROVIDER=local
POPULATION_RASTER_PATH=./data/population
POPULATION_PYTHON_PATH=./.venv-population/bin/python
POPULATION_TILE_SIZE=512
POPULATION_TILE_INDEX_PATH=./artifacts/population/tile-index
```

## Population dataset

Current raster format:

```text
{iso3}_pop_2026_CN_100m_R2025A_v1.tif
```

Example:

```text
ita_pop_2026_CN_100m_R2025A_v1.tif
che_pop_2026_CN_100m_R2025A_v1.tif
fra_pop_2026_CN_100m_R2025A_v1.tif
```

The current dataset is:

- WorldPop Global2;
- R2025A v1;
- year 2026;
- constrained population count;
- approximately 100 m / 3 arc-second cells;
- EPSG:4326;
- values represent estimated people per pixel, not population density.

Raster files are server-side data and must not be committed to Git.

## Multi-raster architecture

The engine discovers compatible raster files automatically from the configured raster directory.

There is no country-specific calculation logic.

For every submitted polygon:

1. compatible rasters are indexed by geographic extent;
2. rasters that do not intersect the polygon are ignored;
3. every intersecting raster contributes independently;
4. contributions are summed into the shape result;
5. shape IDs and ordering are preserved.

A polygon crossing Italy and Switzerland therefore reads both country rasters and returns one combined population value.

Adding another compatible country normally requires only adding its raster file.

## Core calculation

The original local implementation used exact fractional zonal statistics over every relevant raster cell.

For a boundary pixel:

```text
contribution = pixel population × fraction of pixel covered by polygon
```

This is accurate but expensive for huge areas because hundreds of millions of 100 m cells may need to be processed.

The current engine avoids doing this across the entire selected area.

## Tiled preaggregation

Each raster is divided into fixed-size tiles. The current default is:

```text
512 × 512 raster pixels
```

For each tile, the total population is precomputed once using nodata-aware raster values.

At request time, each tile falls into one of three categories:

### Fully outside

The tile contributes nothing.

### Fully inside

The engine uses the precomputed tile population directly.

It does not reread and sum the individual 100 m cells.

This is mathematically equivalent to resumming those cells and therefore does not discard population information.

### Boundary tile

The polygon crosses the tile boundary.

Only these tiles require processing against the original 100 m raster.

This changes the runtime cost from approximately proportional to selected **area** toward approximately proportional to the amount and complexity of the selection **boundary**.

## Tile index

Generated tile indexes are stored under:

```text
artifacts/population/tile-index/
```

They are runtime/generated artifacts and are ignored by Git.

The index contains precomputed population totals and raster metadata required to validate them.

An index is rebuilt when missing, corrupt, or stale.

Staleness checks currently include:

- index schema version;
- configured tile size;
- raster filename set;
- raster file size;
- nanosecond modification time;
- raster dimensions;
- tile layout;
- totals structure.

Rebuilds are protected by a file lock and published atomically.

## Hybrid boundary strategy

The engine intentionally does not use maximum GIS precision for every round.

Worldrawing is a game. The relevant question is whether a faster calculation changes gameplay or scoring materially.

The current rule is:

```text
targetPopulation < 20,000,000
    → fractional boundary calculation

targetPopulation >= 20,000,000
    → pixel-center boundary calculation
```

Fully-inside tiles always use their precomputed totals regardless of mode.

### Fractional mode

Boundary pixels use exact fractional coverage through `exactextract`.

This remains important for low-population targets, where an error of a few hundred people may materially affect the result or score.

### Center mode

For high-population targets, a boundary pixel is included when its center falls inside the polygon and excluded otherwise.

This is significantly faster than fractional intersection processing.

At large population scales, individual boundary-pixel errors tend to become negligible relative to the selected population and the game's scoring tolerance.

## Why the threshold is target-based

Area alone was tested and rejected as the sole switching criterion.

Polygon area does not capture:

- population density;
- elongated or thin geometries;
- perimeter-to-area ratio;
- raster-grid alignment;
- whether the boundary crosses populated or empty areas.

The game target is more directly related to the amount of numerical error that can affect the player's score.

A large absolute population discrepancy may be irrelevant on a 100M target while being unacceptable on a 1,000-person target.

Benchmarking with the real Worldrawing scoring function showed that for sampled targets at or above 20M, center inclusion changed the score by at most one point out of 10,000 across the benchmark set.

## Concurrency

Independent raster calculations are processed concurrently with bounded parallelism.

The implementation limits concurrency according to:

- a maximum worker count;
- available CPU;
- number of relevant rasters.

Each concurrent task opens its own raster dataset.

Results are accumulated deterministically after processing.

## Validation against WorldPop

The local raster engine was initially validated against the WorldPop API using representative Italian polygons.

Normal polygons produced effectively identical totals.

Examples from the initial validation included urban, rural, coastal and larger selections with differences around 0.000–0.001%.

Very small boundary-sensitive polygons exposed differences between undocumented WorldPop API rasterization behavior and exact fractional extraction.

Worldrawing therefore does not attempt to reproduce undocumented WorldPop API edge behavior exactly. It uses its own documented, deterministic calculation rules.

## Performance evolution

Performance measurements below were collected locally on the development Mac and should not be treated as production-server guarantees.

### Initial multi-raster implementation

Eight European rasters, one large polygon:

```text
~9.9 s
```

Fifteen medium shapes:

```text
~5.5 s
```

Profiling showed that almost all runtime was spent processing raster cells, not in Next.js, Python startup, raster discovery, or shape/raster intersection checks.

### Parallel raster processing

After bounded concurrency and whole-raster caching:

```text
large polygon: ~6.9 s
15 shapes:     ~3.6 s
```

### Tiled preaggregation

Standalone 256px-tile validation:

```text
full exactextract: ~8.59 s
tiled:             ~0.57 s
speedup:           ~15×
```

Population difference:

```text
~0.0006 people
```

This is floating-point noise, not meaningful information loss.

The production-oriented implementation uses 512px tiles by default.

### Tiled engine in gameplay

Representative warm local submissions:

```text
large multi-country shape: ~0.92 s
15 medium shapes:          ~1.68 s
```

The large shape benefited more because it contained many fully-inside tiles, while multiple independent shapes create proportionally more boundary work.

### Hybrid strategy

Large-Europe boundary benchmark:

```text
fractional: ~579 ms
center:     ~263 ms
```

The population difference was approximately:

```text
486.9 people / 250.2 million
≈ 0.000195%
```

Recent real gameplay submissions using the hybrid tiled engine were observed around:

```text
center mode:     ~270–336 ms
fractional mode: ~374 ms
```

for the tested selections.

## Accuracy philosophy

The engine is not intended to be a scientific population-analysis product.

Its accuracy requirement is determined by gameplay.

Priorities are:

1. deterministic behavior;
2. no obvious geographic errors;
3. enough precision that the population engine does not materially change round scoring;
4. fast response times;
5. scalability to very large player selections.

Extra precision that cannot affect gameplay is not worth substantial runtime cost.

## Current data coverage

Development currently uses a limited set of European country rasters for validation and performance work.

The architecture is designed so compatible country rasters can be added without country-specific code changes.

The next data milestone is global 2026 coverage.

## Deployment direction

The current local setup reads GeoTIFFs directly from the development filesystem and starts a Python worker from the Next.js server process.

That is suitable for development and correctness validation.

The likely production direction is:

```text
Next.js application
    ↓
population service
    ↓
local/cacheable raster data + tile indexes
    ↓
WorldPop dataset storage
```

Raster data is better suited to filesystem/object storage than to a conventional relational database.

A production service should avoid unnecessary cold process startup and should keep frequently used data/indexes available locally or cached close to the calculation service.

The exact hosting/storage architecture remains a deployment decision rather than a population-algorithm requirement.

## Known limitations / future work

- Global WorldPop raster coverage still needs to be downloaded and organized.
- Performance must be re-benchmarked on production-class infrastructure and storage.
- Concurrent-user load has not yet been benchmarked.
- The current API accepts `Polygon`, not general `MultiPolygon` input.
- Server-side overlap protection is still separate from the frontend rule preventing overlapping player shapes.
- Geographic areas outside installed raster coverage contribute no population.
- Dataset/version upgrades require rebuilding compatible tile indexes.

## Main implementation files

```text
app/api/population/route.ts
features/population/types.ts
features/population/server/provider.ts
features/population/server/worldpop.ts
features/population/server/local-raster.ts
features/population/server/calculation-mode.ts
tools/population/worker.py
tools/population/tile_index.py
tools/population/requirements.txt
```

Long-term correctness checks are isolated from the production worker under:

```text
tools/population/validation/
├── compare_full_vs_tiled.py
├── compare_worldpop.py
└── fixtures/
    ├── europe-large-polygon.json
    └── italy-polygons.json
```

Compare the production tile-index algorithm with a full fractional exactextract
baseline:

```sh
POPULATION_RASTER_PATH="$PWD/data/population" .venv-population/bin/python tools/population/validation/compare_full_vs_tiled.py --tile-size 512 --index-root "$PWD/artifacts/population/tile-index"
```

With a WorldPop-backed development server already running, compare its results
with both supported local boundary modes:

```sh
POPULATION_RASTER_PATH="$PWD/data/population" .venv-population/bin/python tools/population/validation/compare_worldpop.py
```

## Current conclusion

The original external WorldPop API bottleneck has been removed as a technical dependency of the intended population engine.

The validated architecture is:

```text
submitted polygons
    ↓
provider-neutral population boundary
    ↓
local multi-raster engine
    ↓
precomputed 512px tile totals
    ↓
fully-inside tiles → cached population
boundary tiles → fractional or center calculation
    ↓
per-shape population totals
```

The engine now provides a practical balance of accuracy, speed and scalability for Worldrawing gameplay.
