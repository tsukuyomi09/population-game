#!/usr/bin/env python3
"""Calculate population sums for a JSON batch from stdin."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import json
import math
import os
from pathlib import Path
import sys
import time
from typing import Any


RASTER_PATTERN = "*_pop_2026_CN_100m_R2025A_v1.tif"
EXPECTED_RESOLUTION_DEGREES = 1 / 1200
METHODS = ("fractional", "center", "all-touched")
WORKER_READY_MARKER = "__WORLDRAWING_POPULATION_WORKER_READY__"
RASTER_TOTAL_CACHE_FILENAME = ".worldrawing-population-totals.json"
RASTER_TOTAL_CACHE_VERSION = 1
MAX_RASTER_WORKERS = 4


@dataclass(frozen=True)
class RasterIndexEntry:
    path: Path
    bounds: tuple[float, float, float, float]
    size: int
    mtime_ns: int
    total_population: float | None = None
    total_source: str | None = None


@dataclass(frozen=True)
class RasterTiming:
    name: str
    shape_count: int
    open_ms: float
    extraction_method: str
    extraction_ms: float


@dataclass(frozen=True)
class RasterTotalTiming:
    name: str
    open_ms: float
    exactextract_ms: float


@dataclass(frozen=True)
class FastPathTiming:
    name: str
    shape_count: int
    total_source: str


@dataclass(frozen=True)
class RasterWorkResult:
    contributions: list[tuple[int, float]]
    timing: RasterTiming


@dataclass
class WorkerTimings:
    dependency_import_ms: float = 0.0
    raster_discovery_ms: float = 0.0
    raster_metadata_index_ms: float = 0.0
    intersection_checks_ms: float = 0.0
    intersection_check_count: int = 0
    discovered_raster_count: int = 0
    selected_raster_count: int = 0
    containment_check_count: int = 0
    raster_total_cache_ms: float = 0.0
    raster_total_cache_hits: int = 0
    raster_total_cache_misses: int = 0
    raster_total_workers: int = 0
    raster_total_cache_status: str = "unchanged"
    raster_total_timings: list[RasterTotalTiming] = field(default_factory=list)
    fast_path_timings: list[FastPathTiming] = field(default_factory=list)
    concurrent_processing_ms: float = 0.0
    concurrent_worker_count: int = 0
    raster_timings: list[RasterTiming] = field(default_factory=list)
    total_worker_ms: float = 0.0


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--raster",
        default=os.environ.get("POPULATION_RASTER_PATH"),
        help=(
            "Population raster directory or a legacy path to one raster in that directory "
            "(or set POPULATION_RASTER_PATH)."
        ),
    )
    parser.add_argument(
        "--method",
        choices=METHODS,
        default="fractional",
        help="Pixel inclusion rule (default: fractional).",
    )
    return parser.parse_args()


def require_shape(value: Any, index: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"Shape {index} must be an object.")

    shape_id = value.get("id")
    valid_id = (
        isinstance(shape_id, str) and bool(shape_id)
    ) or (
        isinstance(shape_id, (int, float))
        and not isinstance(shape_id, bool)
        and math.isfinite(shape_id)
    )
    if not valid_id:
        raise ValueError(f"Shape {index} has an invalid id.")

    geometry = value.get("geometry")
    if not isinstance(geometry, dict) or geometry.get("type") != "Polygon":
        raise ValueError(f"Shape {index} must contain a GeoJSON Polygon.")

    rings = geometry.get("coordinates")
    if not isinstance(rings, list) or not rings:
        raise ValueError(f"Shape {index} has no polygon rings.")

    for ring_index, ring in enumerate(rings):
        if not isinstance(ring, list) or len(ring) < 4:
            raise ValueError(f"Shape {index} ring {ring_index} must have at least four positions.")
        if ring[0] != ring[-1]:
            raise ValueError(f"Shape {index} ring {ring_index} is not closed.")
        for position in ring:
            if not isinstance(position, list) or len(position) < 2:
                raise ValueError(f"Shape {index} contains an invalid position.")
            longitude, latitude = position[:2]
            if (
                not isinstance(longitude, (int, float))
                or isinstance(longitude, bool)
                or not math.isfinite(longitude)
                or not -180 <= longitude <= 180
                or not isinstance(latitude, (int, float))
                or isinstance(latitude, bool)
                or not math.isfinite(latitude)
                or not -90 <= latitude <= 90
            ):
                raise ValueError(f"Shape {index} contains invalid WGS84 coordinates.")

    return value


def read_shapes() -> list[dict[str, Any]]:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict) or not isinstance(payload.get("shapes"), list):
        raise ValueError("Input must be a JSON object containing a shapes array.")
    return [require_shape(shape, index) for index, shape in enumerate(payload["shapes"])]


def validate_raster(raster: Any, raster_path: Path) -> None:
    if raster.count != 1:
        raise ValueError(
            f"Expected a single-band raster, found {raster.count} bands: {raster_path}"
        )
    if raster.crs is None or raster.crs.to_epsg() != 4326:
        raise ValueError(f"Expected an EPSG:4326 raster, found {raster.crs}: {raster_path}")
    if raster.nodata is None:
        raise ValueError(f"Expected the population raster to declare nodata: {raster_path}")
    if not (
        math.isclose(abs(raster.transform.a), EXPECTED_RESOLUTION_DEGREES, abs_tol=1e-10)
        and math.isclose(abs(raster.transform.e), EXPECTED_RESOLUTION_DEGREES, abs_tol=1e-10)
    ):
        raise ValueError(
            "Expected a 3 arc-second raster; "
            f"found pixel size {abs(raster.transform.a)} x "
            f"{abs(raster.transform.e)} degrees: {raster_path}"
        )


def discover_rasters(
    raster_source_path: Path,
    rasterio: Any,
    timings: WorkerTimings,
) -> tuple[list[RasterIndexEntry], Path]:
    discovery_started_at = time.perf_counter()
    if raster_source_path.is_dir():
        raster_directory = raster_source_path
    elif raster_source_path.is_file():
        # Preserve the original single-file configuration while discovering its siblings.
        raster_directory = raster_source_path.parent
    else:
        raise FileNotFoundError(
            f"Population raster directory or file not found: {raster_source_path}"
        )

    raster_paths = sorted(raster_directory.glob(RASTER_PATTERN))
    if not raster_paths:
        raise FileNotFoundError(
            f"No compatible population rasters matching {RASTER_PATTERN} in {raster_directory}"
        )
    timings.raster_discovery_ms = (time.perf_counter() - discovery_started_at) * 1_000
    timings.discovered_raster_count = len(raster_paths)

    metadata_started_at = time.perf_counter()
    raster_index: list[RasterIndexEntry] = []
    for raster_path in raster_paths:
        raster_stat = raster_path.stat()
        with rasterio.open(raster_path) as raster:
            validate_raster(raster, raster_path)
            raster_index.append(
                RasterIndexEntry(
                    path=raster_path,
                    bounds=(
                        float(raster.bounds.left),
                        float(raster.bounds.bottom),
                        float(raster.bounds.right),
                        float(raster.bounds.top),
                    ),
                    size=raster_stat.st_size,
                    mtime_ns=raster_stat.st_mtime_ns,
                )
            )
    timings.raster_metadata_index_ms = (time.perf_counter() - metadata_started_at) * 1_000

    return raster_index, raster_directory


def load_raster_total_cache(cache_path: Path) -> dict[str, Any]:
    try:
        with cache_path.open(encoding="utf-8") as cache_file:
            cache = json.load(cache_file)
    except (FileNotFoundError, OSError, ValueError):
        return {}

    if (
        not isinstance(cache, dict)
        or cache.get("version") != RASTER_TOTAL_CACHE_VERSION
        or not isinstance(cache.get("rasters"), dict)
    ):
        return {}
    return cache["rasters"]


def read_cached_raster_total(
    entry: RasterIndexEntry,
    cached_rasters: dict[str, Any],
) -> float | None:
    cached = cached_rasters.get(entry.path.name)
    if not isinstance(cached, dict):
        return None

    total = cached.get("total_population")
    if (
        cached.get("size") != entry.size
        or cached.get("mtime_ns") != entry.mtime_ns
        or not isinstance(total, (int, float))
        or isinstance(total, bool)
        or not math.isfinite(total)
        or total < 0
    ):
        return None
    return float(total)


def raster_bounds_geometry(bounds: tuple[float, float, float, float]) -> dict[str, Any]:
    left, bottom, right, top = bounds
    return {
        "type": "Polygon",
        "coordinates": [[
            [left, bottom],
            [right, bottom],
            [right, top],
            [left, top],
            [left, bottom],
        ]],
    }


def extract_fractional_population(
    raster: Any,
    shapes: list[dict[str, Any]],
    relevant_indices: list[int],
    exact_extract: Any,
    json_feature_source: Any,
) -> tuple[list[tuple[int, float]], float]:
    features = [
        {
            "type": "Feature",
            "properties": {"shape_index": index},
            "geometry": shapes[index]["geometry"],
        }
        for index in relevant_indices
    ]
    vector = json_feature_source(features, srs_wkt=raster.crs.to_wkt())
    extraction_started_at = time.perf_counter()
    extracted = exact_extract(
        raster,
        vector,
        "population=sum(default_value=0)",
        include_cols=["shape_index"],
        progress=False,
    )
    extraction_ms = (time.perf_counter() - extraction_started_at) * 1_000
    if len(extracted) != len(relevant_indices):
        raise RuntimeError("exactextract returned an unexpected number of results.")

    contributions: list[tuple[int, float]] = []
    for output_index, feature in enumerate(extracted):
        properties = feature.get("properties", {})
        shape_index = properties.get("shape_index")
        expected_shape_index = relevant_indices[output_index]
        if shape_index != expected_shape_index:
            raise RuntimeError("exactextract did not preserve the submitted shape index.")
        population_value = properties.get("population")
        contributions.append(
            (expected_shape_index, 0.0 if population_value is None else float(population_value))
        )

    return contributions, extraction_ms


def extract_binary_population(
    raster: Any,
    shapes: list[dict[str, Any]],
    relevant_indices: list[int],
    method: str,
    mask_raster: Any,
) -> tuple[list[tuple[int, float]], float]:
    extraction_started_at = time.perf_counter()
    contributions: list[tuple[int, float]] = []
    for shape_index in relevant_indices:
        try:
            selected, _ = mask_raster(
                raster,
                [shapes[shape_index]["geometry"]],
                all_touched=method == "all-touched",
                crop=True,
                filled=False,
                indexes=1,
            )
        except ValueError:
            # A geometry that only touches the raster's outer boundary has no cells.
            contributions.append((shape_index, 0.0))
            continue
        population = float(selected.sum(dtype="float64")) if selected.count() else 0.0
        contributions.append((shape_index, population))

    return contributions, (time.perf_counter() - extraction_started_at) * 1_000


def bounded_worker_count(task_count: int) -> int:
    return min(task_count, MAX_RASTER_WORKERS, max(1, os.cpu_count() or 1))


def calculate_raster_total(
    entry: RasterIndexEntry,
    rasterio: Any,
    exact_extract: Any,
    json_feature_source: Any,
) -> tuple[float, RasterTotalTiming]:
    raster_open_started_at = time.perf_counter()
    raster = rasterio.open(entry.path)
    raster_open_ms = (time.perf_counter() - raster_open_started_at) * 1_000
    try:
        validate_raster(raster, entry.path)
        contributions, exactextract_ms = extract_fractional_population(
            raster,
            [{"geometry": raster_bounds_geometry(entry.bounds)}],
            [0],
            exact_extract,
            json_feature_source,
        )
    finally:
        raster.close()

    total = contributions[0][1]
    if not math.isfinite(total) or total < 0:
        raise RuntimeError(f"Invalid total population for raster {entry.path}: {total}")
    return total, RasterTotalTiming(entry.path.name, raster_open_ms, exactextract_ms)


def write_raster_total_cache(
    cache_path: Path,
    raster_index: list[RasterIndexEntry],
) -> tuple[bool, str | None]:
    payload = {
        "version": RASTER_TOTAL_CACHE_VERSION,
        "rasters": {
            entry.path.name: {
                "size": entry.size,
                "mtime_ns": entry.mtime_ns,
                "total_population": entry.total_population,
            }
            for entry in raster_index
        },
    }
    temporary_path = cache_path.with_name(f"{cache_path.name}.{os.getpid()}.tmp")
    try:
        with temporary_path.open("w", encoding="utf-8") as cache_file:
            json.dump(payload, cache_file, allow_nan=False, separators=(",", ":"))
            cache_file.write("\n")
        os.replace(temporary_path, cache_path)
        return True, None
    except OSError as error:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass
        return False, str(error)


def resolve_raster_totals(
    raster_index: list[RasterIndexEntry],
    raster_directory: Path,
    rasterio: Any,
    exact_extract: Any,
    json_feature_source: Any,
    timings: WorkerTimings,
) -> list[RasterIndexEntry]:
    cache_started_at = time.perf_counter()
    cache_path = raster_directory / RASTER_TOTAL_CACHE_FILENAME
    cached_rasters = load_raster_total_cache(cache_path)
    resolved_by_name: dict[str, RasterIndexEntry] = {}
    missing_entries: list[RasterIndexEntry] = []

    for entry in raster_index:
        cached_total = read_cached_raster_total(entry, cached_rasters)
        if cached_total is None:
            missing_entries.append(entry)
            continue
        timings.raster_total_cache_hits += 1
        resolved_by_name[entry.path.name] = RasterIndexEntry(
            path=entry.path,
            bounds=entry.bounds,
            size=entry.size,
            mtime_ns=entry.mtime_ns,
            total_population=cached_total,
            total_source="cache",
        )

    timings.raster_total_cache_misses = len(missing_entries)
    timings.raster_total_workers = bounded_worker_count(len(missing_entries))

    if missing_entries:
        if timings.raster_total_workers == 1:
            computed_totals = [
                calculate_raster_total(
                    missing_entries[0], rasterio, exact_extract, json_feature_source
                )
            ]
        else:
            with ThreadPoolExecutor(max_workers=timings.raster_total_workers) as executor:
                futures = [
                    executor.submit(
                        calculate_raster_total,
                        entry,
                        rasterio,
                        exact_extract,
                        json_feature_source,
                    )
                    for entry in missing_entries
                ]
                computed_totals = [future.result() for future in futures]

        for entry, (total, total_timing) in zip(missing_entries, computed_totals):
            timings.raster_total_timings.append(total_timing)
            resolved_by_name[entry.path.name] = RasterIndexEntry(
                path=entry.path,
                bounds=entry.bounds,
                size=entry.size,
                mtime_ns=entry.mtime_ns,
                total_population=total,
                total_source="computed",
            )

    resolved_index = [resolved_by_name[entry.path.name] for entry in raster_index]
    if missing_entries:
        cache_written, cache_error = write_raster_total_cache(cache_path, resolved_index)
        timings.raster_total_cache_status = (
            "updated" if cache_written else f"not persisted ({cache_error})"
        )
    else:
        timings.raster_total_cache_status = "all hits"

    timings.raster_total_cache_ms = (time.perf_counter() - cache_started_at) * 1_000
    return resolved_index


def process_partial_raster(
    entry: RasterIndexEntry,
    shapes: list[dict[str, Any]],
    relevant_indices: list[int],
    method: str,
    rasterio: Any,
    exact_extract: Any,
    json_feature_source: Any,
    mask_raster: Any,
) -> RasterWorkResult:
    raster_open_started_at = time.perf_counter()
    raster = rasterio.open(entry.path)
    raster_open_ms = (time.perf_counter() - raster_open_started_at) * 1_000
    try:
        validate_raster(raster, entry.path)
        if method == "fractional":
            contributions, extraction_ms = extract_fractional_population(
                raster,
                shapes,
                relevant_indices,
                exact_extract,
                json_feature_source,
            )
            extraction_method = "exactextract"
        else:
            contributions, extraction_ms = extract_binary_population(
                raster,
                shapes,
                relevant_indices,
                method,
                mask_raster,
            )
            extraction_method = method
    finally:
        raster.close()

    return RasterWorkResult(
        contributions=contributions,
        timing=RasterTiming(
            name=entry.path.name,
            shape_count=len(relevant_indices),
            open_ms=raster_open_ms,
            extraction_method=extraction_method,
            extraction_ms=extraction_ms,
        ),
    )


def calculate_population(
    raster_source_path: Path,
    shapes: list[dict[str, Any]],
    method: str,
    timings: WorkerTimings,
) -> list[dict[str, Any]]:
    if not shapes:
        return []

    dependency_import_started_at = time.perf_counter()
    try:
        import rasterio
        from exactextract import exact_extract
        from exactextract.feature import JSONFeatureSource
        from rasterio.mask import mask as mask_raster
        from shapely.geometry import box, shape as read_geometry
    except ImportError as error:
        raise RuntimeError(
            "Python geospatial dependencies are missing; install tools/population/requirements.txt."
        ) from error
    timings.dependency_import_ms = (time.perf_counter() - dependency_import_started_at) * 1_000

    raster_index, raster_directory = discover_rasters(raster_source_path, rasterio, timings)
    raster_index = resolve_raster_totals(
        raster_index,
        raster_directory,
        rasterio,
        exact_extract,
        JSONFeatureSource,
        timings,
    )
    shape_geometries = [read_geometry(shape["geometry"]) for shape in shapes]
    populations = [0.0 for _ in shapes]
    full_contributions_by_raster: dict[Path, list[tuple[int, float]]] = {}
    partial_jobs: list[tuple[RasterIndexEntry, list[int]]] = []

    for raster_entry in raster_index:
        intersection_started_at = time.perf_counter()
        raster_extent = box(*raster_entry.bounds)
        fully_contained_indices: list[int] = []
        partially_intersected_indices: list[int] = []
        for index, geometry in enumerate(shape_geometries):
            if not geometry.intersects(raster_extent):
                continue
            timings.containment_check_count += 1
            if geometry.covers(raster_extent):
                fully_contained_indices.append(index)
            else:
                partially_intersected_indices.append(index)
        timings.intersection_checks_ms += (
            time.perf_counter() - intersection_started_at
        ) * 1_000
        timings.intersection_check_count += len(shape_geometries)
        if not fully_contained_indices and not partially_intersected_indices:
            continue
        timings.selected_raster_count += 1

        if fully_contained_indices:
            if raster_entry.total_population is None or raster_entry.total_source is None:
                raise RuntimeError(f"Missing total population for raster {raster_entry.path}")
            full_contributions_by_raster[raster_entry.path] = [
                (shape_index, raster_entry.total_population)
                for shape_index in fully_contained_indices
            ]
            timings.fast_path_timings.append(
                FastPathTiming(
                    name=raster_entry.path.name,
                    shape_count=len(fully_contained_indices),
                    total_source=raster_entry.total_source,
                )
            )

        if partially_intersected_indices:
            partial_jobs.append((raster_entry, partially_intersected_indices))

    timings.concurrent_worker_count = bounded_worker_count(len(partial_jobs))
    concurrent_processing_started_at = time.perf_counter()
    if partial_jobs:
        if timings.concurrent_worker_count == 1:
            entry, relevant_indices = partial_jobs[0]
            partial_results = [
                process_partial_raster(
                    entry,
                    shapes,
                    relevant_indices,
                    method,
                    rasterio,
                    exact_extract,
                    JSONFeatureSource,
                    mask_raster,
                )
            ]
        else:
            with ThreadPoolExecutor(max_workers=timings.concurrent_worker_count) as executor:
                futures = [
                    executor.submit(
                        process_partial_raster,
                        entry,
                        shapes,
                        relevant_indices,
                        method,
                        rasterio,
                        exact_extract,
                        JSONFeatureSource,
                        mask_raster,
                    )
                    for entry, relevant_indices in partial_jobs
                ]
                partial_results = [future.result() for future in futures]

        partial_contributions_by_raster = {
            partial_result.timing.name: partial_result.contributions
            for partial_result in partial_results
        }
        timings.raster_timings.extend(
            partial_result.timing for partial_result in partial_results
        )
    else:
        partial_contributions_by_raster = {}
    timings.concurrent_processing_ms = (
        time.perf_counter() - concurrent_processing_started_at
    ) * 1_000

    # Preserve the original raster-order accumulation even though extraction ran
    # concurrently, avoiding new floating-point ordering differences.
    for raster_entry in raster_index:
        contributions = [
            *full_contributions_by_raster.get(raster_entry.path, []),
            *partial_contributions_by_raster.get(raster_entry.path.name, []),
        ]
        for shape_index, population in contributions:
            populations[shape_index] += population

    results: list[dict[str, Any]] = []
    for index, population in enumerate(populations):
        shape_id = shapes[index]["id"]
        if not math.isfinite(population) or population < 0:
            raise RuntimeError(f"Invalid population result for shape {shape_id!r}: {population}")
        results.append({"id": shape_id, "population": population})

    return results


def write_timing_report(timings: WorkerTimings) -> None:
    lines = [
        "[population-worker timing]",
        f"  geospatial dependency imports: {timings.dependency_import_ms:.1f} ms",
        (
            f"  raster discovery: {timings.raster_discovery_ms:.1f} ms "
            f"({timings.discovered_raster_count} compatible rasters)"
        ),
        f"  raster metadata/index: {timings.raster_metadata_index_ms:.1f} ms",
        (
            f"  raster total cache: {timings.raster_total_cache_ms:.1f} ms "
            f"({timings.raster_total_cache_hits} hits, "
            f"{timings.raster_total_cache_misses} computed, "
            f"{timings.raster_total_workers} workers, "
            f"{timings.raster_total_cache_status})"
        ),
        (
            f"  polygon/raster intersections: {timings.intersection_checks_ms:.1f} ms "
            f"({timings.intersection_check_count} checks, "
            f"{timings.containment_check_count} containment checks, "
            f"{timings.selected_raster_count} selected rasters)"
        ),
    ]
    for raster_total_timing in timings.raster_total_timings:
        lines.append(
            f"    total computed {raster_total_timing.name}: "
            f"open {raster_total_timing.open_ms:.1f} ms; "
            f"exactextract {raster_total_timing.exactextract_ms:.1f} ms"
        )

    fast_path_shape_count = sum(
        timing.shape_count for timing in timings.fast_path_timings
    )
    lines.append(
        f"  full-containment fast path: {len(timings.fast_path_timings)} rasters, "
        f"{fast_path_shape_count} raster/shape matches"
    )
    for fast_path_timing in timings.fast_path_timings:
        lines.append(
            f"    {fast_path_timing.name}: cached total applied to "
            f"{fast_path_timing.shape_count} shapes "
            f"(total source: {fast_path_timing.total_source})"
        )

    lines.append(
        f"  concurrent partial-raster processing: {timings.concurrent_processing_ms:.1f} ms "
        f"({len(timings.raster_timings)} rasters, "
        f"{timings.concurrent_worker_count} workers)"
    )
    for raster_timing in timings.raster_timings:
        lines.append(
            f"    {raster_timing.name}: open {raster_timing.open_ms:.1f} ms; "
            f"{raster_timing.extraction_method} {raster_timing.extraction_ms:.1f} ms; "
            f"{raster_timing.shape_count} shapes"
        )
    lines.append(f"  total worker (ready to result): {timings.total_worker_ms:.1f} ms")
    print("\n".join(lines), file=sys.stderr, flush=True)


def main() -> int:
    arguments = parse_arguments()
    print(WORKER_READY_MARKER, file=sys.stderr, flush=True)
    worker_started_at = time.perf_counter()
    timings = WorkerTimings()

    try:
        if not arguments.raster:
            raise ValueError("Provide --raster or set POPULATION_RASTER_PATH.")
        shapes = read_shapes()
        results = calculate_population(
            Path(arguments.raster).expanduser().resolve(),
            shapes,
            arguments.method,
            timings,
        )
        output = json.dumps(results, allow_nan=False, separators=(",", ":"))
        timings.total_worker_ms = (time.perf_counter() - worker_started_at) * 1_000
        write_timing_report(timings)
        sys.stdout.write(f"{output}\n")
        return 0
    except Exception as error:
        print(f"Population worker error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
