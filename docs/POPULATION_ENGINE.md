# Population engine

## Current and target architecture

`POST /api/population` delegates to a configured server-side provider and defaults
to the WorldPop API. WorldPop provides real population data, but its polygon-size
limits, request quota, and asynchronous per-polygon jobs are not suitable for the
full game.

The target boundary remains:

```text
frontend -> /api/population -> batch population provider -> dataset/service
```

The public request and response contract does not change. Requests contain a
`shapes` array of stable IDs and GeoJSON Polygons; responses contain one
`{ id, population }` result per shape plus `totalPopulation`.

## Population rule

Local validation established exact fractional coverage through exactextract as
Worldrawing's population rule. Reproducing undocumented WorldPop API behavior
for individual boundary pixels is not required.

Local gameplay testing currently uses compatible 2026 WorldPop Global2 rasters
for Italy and Switzerland:

```text
data/population/ita_pop_2026_CN_100m_R2025A_v1.tif
data/population/che_pop_2026_CN_100m_R2025A_v1.tif
```

These are constrained R2025A v1 population-count GeoTIFFs: WGS84, 3 arc-second
(approximately 100 m) cells, with values representing people per pixel. The
worker therefore uses exactextract's `sum`, which weights each cell value by the
polygon's exact fractional coverage. It does not apply a cell-area multiplier,
which would be required for population-density rasters.

The local implementation is an isolated Python worker using `exactextract` and
`rasterio`. It accepts all submitted shapes as one JSON batch on stdin and
returns `{ id, population }` results on stdout. Diagnostics are written to
stderr. WorldPop remains available as the default provider and reference.

The comparison harness evaluates three established inclusion rules:

- exact fractional coverage using exactextract's weighted `sum`
- Rasterio's default center rule (`all_touched=False`), including its documented
  Bresenham boundary behavior
- Rasterio's all-touched rule (`all_touched=True`)

## Provider selection

Provider selection is server-side and does not change the `/api/population`
contract.

```text
POPULATION_PROVIDER=worldpop  # default, including when unset
POPULATION_PROVIDER=local     # discovered country rasters and Python worker
```

Local mode also requires:

```text
POPULATION_RASTER_PATH=./data/population
POPULATION_PYTHON_PATH=./.venv-population/bin/python
```

`POPULATION_RASTER_PATH` may point to the raster directory or, for backward
compatibility, to one raster inside it. In both cases the worker scans that
directory for files matching:

```text
*_pop_2026_CN_100m_R2025A_v1.tif
```

Every discovered raster is validated and indexed by its geographic extent once
per worker batch. Each submitted polygon is intersected with those extents using
Shapely. Rasters with no intersection are skipped. The worker runs exactextract
against each partially intersected raster and sums all raster contributions into
the shape's single result. A polygon crossing Italy and Switzerland therefore
uses both country rasters while preserving its original ID. Adding another
compatible country requires only placing its matching file in the directory.

The worker keeps a generated `.worldrawing-population-totals.json` sidecar in
the raster directory. On a cache miss, it calculates each raster total with the
same exactextract `sum(default_value=0)` operation over the raster's complete
bounds, preserving the normal nodata behavior. Cache entries are invalidated by
the raster's filename, byte size, and nanosecond modification time. The first
request after adding or replacing rasters pays this one-time calculation cost;
later worker processes reuse the totals.

If a submitted polygon covers a raster's complete rectangular extent, the
worker adds that raster's cached total without running exactextract for that
polygon/raster pair. This test is deliberately conservative: a polygon that
covers all valid country pixels but not the raster's full bounding rectangle
still follows the regular exactextract path. Partially intersected rasters are
processed concurrently with a maximum of four threads (and never more threads
than available CPUs or partial rasters). Every thread opens its own raster, and
results are merged in raster discovery order to retain deterministic summation.

The local provider always invokes the worker with `--method fractional`. It
checks that the raster source and worker are readable, enforces a worker timeout,
and rejects process failures, malformed output, non-finite or negative
populations, and mismatched result IDs. It does not silently retry through
WorldPop.

For a one-command local development start from the repository root:

```sh
POPULATION_PROVIDER=local POPULATION_RASTER_PATH="$PWD/data/population" POPULATION_PYTHON_PATH="$PWD/.venv-population/bin/python" npm run dev
```

Each successful local request writes one `[local-population timing]` block to
the Next.js server log. It reports Python process startup, geospatial dependency
imports, raster discovery, raster metadata/index creation, raster-total cache
hits and misses, aggregate polygon/raster containment checks, rasters resolved
by the full-containment fast path, concurrent partial-raster wall time,
processing-open and exactextract time for every partial raster, total worker
time, and total Next.js adapter time. These diagnostics travel over the worker's
stderr stream and are never added to the public API response.

## Calculation benchmark

`tools/population/benchmark.py` is an isolated diagnostic and is not used by the
provider. For each raster intersected by one polygon, it derives one canonical
pixel window and benchmarks a raw window read, raw nodata-aware sum, Rasterio
center and all-touched masks, and fractional exactextract. Work is streamed in
bounded chunks. A window-limited exactextract raster source ensures the
fractional path sees the same spatial window as the other methods.

The bundled eight-country example can be run from the repository root with:

```sh
.venv-population/bin/python tools/population/benchmark.py
```

Use `--polygon PATH` to benchmark a saved GeoJSON Polygon, Feature, or original
`/api/population` request payload. If the payload contains multiple shapes,
select one with `--shape-id ID`.

### Tiled preaggregation spike

`tools/population/tiled_benchmark.py` prototypes raster-aligned tile totals
without changing the provider. Generated indexes are written below the ignored
`artifacts/population/tile-index/` directory. Tiles covered completely by the
polygon contribute a nodata-aware precomputed sum; only intersecting boundary
tiles use the original fractional exactextract operation against 100 m pixels.

The bundled large-Europe polygon produced these results on the local eight-file
dataset (full exactextract processed 546,975,410 pixels):

| Tile size | Preprocess | Index | Total tiles | Inside | Boundary | Boundary pixels | Tiled runtime | Same-run speedup | Population difference |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 128 | 5.287 s | 204,597 B | 67,733 | 29,415 | 569 | 9,272,832 | 1.223 s | 6.65x | 0.000608 |
| 256 | 4.137 s | 57,210 B | 17,082 | 7,395 | 286 | 18,583,808 | 0.571 s | 15.03x | 0.000610 |
| 512 | 3.796 s | 17,191 B | 4,322 | 1,853 | 146 | 37,692,928 | 0.519 s | 15.75x | 0.000609 |

The 512-pixel prototype was slightly faster than 256 despite processing more
boundary pixels, showing that per-tile exactextract call overhead matters at
this scale. The sub-0.001-person differences come from floating-point summation
order; boundary pixels still use exact fractional coverage. These measurements
are spike results, not a production tile-size or storage decision.

Rebuild and run the requested 256-pixel benchmark with:

```sh
.venv-population/bin/python tools/population/tiled_benchmark.py --tile-size 256 --rebuild
```

Local mode covers only the compatible country files currently present in the
raster directory; it is not global coverage. The map does not constrain drawings
to those countries, and areas outside discovered rasters and their valid-data
masks contribute zero.

The production process model, raster storage strategy, global tiling and cache
strategy, and large-area execution architecture remain intentionally undecided.
This provider switch is only for limited-country gameplay testing.
