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

from tile_index import (
    DEFAULT_INDEX_ROOT,
    DEFAULT_TILE_SIZE,
    discover_raster_paths,
    index_path,
    prepare_index,
    tile_window,
)


EXPECTED_RESOLUTION_DEGREES = 1 / 1200
METHODS = ("fractional", "center", "all-touched")
WORKER_READY_MARKER = "__WORLDRAWING_POPULATION_WORKER_READY__"
MAX_RASTER_WORKERS = 4


@dataclass(frozen=True)
class RasterIndexEntry:
    path: Path
    bounds: tuple[float, float, float, float]


@dataclass(frozen=True)
class RasterTiming:
    name: str
    shape_count: int
    open_ms: float
    classification_ms: float
    classification_checks: int
    fully_inside_tile_matches: int
    boundary_tiles: int
    boundary_shape_matches: int
    boundary_pixels: int
    extraction_method: str
    extraction_ms: float


@dataclass(frozen=True)
class RasterWorkResult:
    contributions: list[tuple[int, float]]
    timing: RasterTiming


@dataclass
class WorkerTimings:
    dependency_import_ms: float = 0.0
    raster_discovery_ms: float = 0.0
    raster_metadata_index_ms: float = 0.0
    discovered_raster_count: int = 0
    selected_raster_count: int = 0
    raster_intersection_ms: float = 0.0
    raster_intersection_checks: int = 0
    tile_index_ms: float = 0.0
    tile_index_build_ms: float = 0.0
    tile_index_rebuilt: bool = False
    tile_index_path: str = ""
    tile_index_size: int = 0
    tile_size: int = 0
    total_tiles: int = 0
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
    parser.add_argument(
        "--tile-size",
        type=int,
        default=int(os.environ.get("POPULATION_TILE_SIZE", DEFAULT_TILE_SIZE)),
        help=f"Preaggregation tile width and height (default: {DEFAULT_TILE_SIZE}).",
    )
    parser.add_argument(
        "--tile-index-root",
        default=os.environ.get("POPULATION_TILE_INDEX_PATH", str(DEFAULT_INDEX_ROOT)),
        help="Directory for generated tile indexes.",
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
    if raster.scales[0] != 1.0 or raster.offsets[0] != 0.0:
        raise ValueError(f"Expected an unscaled population-count raster: {raster_path}")
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
) -> list[RasterIndexEntry]:
    discovery_started_at = time.perf_counter()
    raster_paths = discover_raster_paths(raster_source_path)
    timings.raster_discovery_ms = (time.perf_counter() - discovery_started_at) * 1_000
    timings.discovered_raster_count = len(raster_paths)

    metadata_started_at = time.perf_counter()
    raster_index: list[RasterIndexEntry] = []
    for raster_path in raster_paths:
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
                )
            )
    timings.raster_metadata_index_ms = (time.perf_counter() - metadata_started_at) * 1_000
    return raster_index


def bounded_worker_count(task_count: int) -> int:
    return min(task_count, MAX_RASTER_WORKERS, max(1, os.cpu_count() or 1))


def make_windowed_raster_source(
    raster: Any,
    window: Any,
    rasterio_raster_source: Any,
    raster_source_base: Any,
    window_bounds: Any,
) -> Any:
    parent_source = rasterio_raster_source(raster)
    left, bottom, right, top = window_bounds(window, raster.transform)

    class WindowedRasterSource(raster_source_base):
        def __init__(self) -> None:
            super().__init__()

        def res(self) -> tuple[float, float]:
            return parent_source.res()

        def extent(self) -> tuple[float, float, float, float]:
            return (left, bottom, right, top)

        def nodata_value(self) -> Any:
            return parent_source.nodata_value()

        def srs_wkt(self) -> str | None:
            return parent_source.srs_wkt()

        def read_window(self, x0: int, y0: int, nx: int, ny: int) -> Any:
            return parent_source.read_window(
                int(window.col_off) + x0,
                int(window.row_off) + y0,
                nx,
                ny,
            )

    return WindowedRasterSource()


def extract_fractional_population(
    raster_source: Any,
    raster_crs: Any,
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
    vector = json_feature_source(features, srs_wkt=raster_crs.to_wkt())
    extraction_started_at = time.perf_counter()
    extracted = exact_extract(
        raster_source,
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


def process_tiled_raster(
    entry: RasterIndexEntry,
    tile_entry: dict[str, Any],
    tile_size: int,
    shapes: list[dict[str, Any]],
    shape_geometries: list[Any],
    relevant_indices: list[int],
    dependencies: dict[str, Any],
) -> RasterWorkResult:
    raster_open_started_at = time.perf_counter()
    raster = dependencies["rasterio"].open(entry.path)
    raster_open_ms = (time.perf_counter() - raster_open_started_at) * 1_000
    raster_populations = {index: 0.0 for index in relevant_indices}
    classification_ms = 0.0
    classification_checks = 0
    fully_inside_tile_matches = 0
    boundary_tiles = 0
    boundary_shape_matches = 0
    boundary_pixels = 0
    extraction_ms = 0.0

    try:
        validate_raster(raster, entry.path)
        if tile_entry["width"] != raster.width or tile_entry["height"] != raster.height:
            raise RuntimeError(f"Tile index dimensions do not match raster {entry.path}")
        totals = tile_entry["totals"]

        for tile_row in range(tile_entry["tile_rows"]):
            for tile_column in range(tile_entry["tile_columns"]):
                window = tile_window(
                    tile_row,
                    tile_column,
                    tile_size,
                    raster.width,
                    raster.height,
                    dependencies["window_type"],
                )
                extent = dependencies["box"](
                    *dependencies["window_bounds"](window, raster.transform)
                )
                boundary_indices: list[int] = []
                classification_started_at = time.perf_counter()
                for shape_index in relevant_indices:
                    classification_checks += 1
                    geometry = shape_geometries[shape_index]
                    if not geometry.intersects(extent):
                        continue
                    if geometry.covers(extent):
                        total_offset = (
                            tile_row * tile_entry["tile_columns"] + tile_column
                        )
                        raster_populations[shape_index] += float(totals[total_offset])
                        fully_inside_tile_matches += 1
                    else:
                        boundary_indices.append(shape_index)
                classification_ms += (
                    time.perf_counter() - classification_started_at
                ) * 1_000

                if not boundary_indices:
                    continue
                boundary_tiles += 1
                boundary_shape_matches += len(boundary_indices)
                boundary_pixels += int(window.width) * int(window.height)
                source = make_windowed_raster_source(
                    raster,
                    window,
                    dependencies["rasterio_raster_source"],
                    dependencies["raster_source_base"],
                    dependencies["window_bounds"],
                )
                contributions, tile_extraction_ms = extract_fractional_population(
                    source,
                    raster.crs,
                    shapes,
                    boundary_indices,
                    dependencies["exact_extract"],
                    dependencies["json_feature_source"],
                )
                extraction_ms += tile_extraction_ms
                for shape_index, population in contributions:
                    raster_populations[shape_index] += population
    finally:
        raster.close()

    return RasterWorkResult(
        contributions=list(raster_populations.items()),
        timing=RasterTiming(
            name=entry.path.name,
            shape_count=len(relevant_indices),
            open_ms=raster_open_ms,
            classification_ms=classification_ms,
            classification_checks=classification_checks,
            fully_inside_tile_matches=fully_inside_tile_matches,
            boundary_tiles=boundary_tiles,
            boundary_shape_matches=boundary_shape_matches,
            boundary_pixels=boundary_pixels,
            extraction_method="exactextract",
            extraction_ms=extraction_ms,
        ),
    )


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
            contributions.append((shape_index, 0.0))
            continue
        population = float(selected.sum(dtype="float64")) if selected.count() else 0.0
        contributions.append((shape_index, population))
    return contributions, (time.perf_counter() - extraction_started_at) * 1_000


def process_binary_raster(
    entry: RasterIndexEntry,
    shapes: list[dict[str, Any]],
    relevant_indices: list[int],
    method: str,
    dependencies: dict[str, Any],
) -> RasterWorkResult:
    raster_open_started_at = time.perf_counter()
    raster = dependencies["rasterio"].open(entry.path)
    raster_open_ms = (time.perf_counter() - raster_open_started_at) * 1_000
    try:
        validate_raster(raster, entry.path)
        contributions, extraction_ms = extract_binary_population(
            raster,
            shapes,
            relevant_indices,
            method,
            dependencies["mask_raster"],
        )
    finally:
        raster.close()
    return RasterWorkResult(
        contributions=contributions,
        timing=RasterTiming(
            name=entry.path.name,
            shape_count=len(relevant_indices),
            open_ms=raster_open_ms,
            classification_ms=0.0,
            classification_checks=0,
            fully_inside_tile_matches=0,
            boundary_tiles=0,
            boundary_shape_matches=0,
            boundary_pixels=0,
            extraction_method=method,
            extraction_ms=extraction_ms,
        ),
    )


def calculate_population(
    raster_source_path: Path,
    shapes: list[dict[str, Any]],
    method: str,
    tile_size: int,
    tile_index_root: Path,
    timings: WorkerTimings,
) -> list[dict[str, Any]]:
    if not shapes:
        return []

    dependency_import_started_at = time.perf_counter()
    try:
        import rasterio
        from exactextract import exact_extract
        from exactextract.feature import JSONFeatureSource
        from exactextract.raster import RasterioRasterSource, RasterSource
        from rasterio.mask import mask as mask_raster
        from rasterio.windows import Window, bounds as window_bounds
        from shapely.geometry import box, shape as read_geometry
    except ImportError as error:
        raise RuntimeError(
            "Python geospatial dependencies are missing; install tools/population/requirements.txt."
        ) from error
    timings.dependency_import_ms = (time.perf_counter() - dependency_import_started_at) * 1_000

    raster_index = discover_rasters(raster_source_path, rasterio, timings)
    raster_paths = [entry.path for entry in raster_index]
    tile_data: dict[str, Any] | None = None
    if method == "fractional":
        tile_index_started_at = time.perf_counter()
        tile_index_file = index_path(tile_index_root, tile_size)
        tile_data, build_seconds, rebuilt = prepare_index(
            raster_paths,
            tile_index_file,
            tile_size,
            False,
            rasterio,
            Window,
        )
        timings.tile_index_ms = (time.perf_counter() - tile_index_started_at) * 1_000
        timings.tile_index_build_ms = build_seconds * 1_000
        timings.tile_index_rebuilt = rebuilt
        timings.tile_index_path = str(tile_index_file)
        timings.tile_index_size = tile_index_file.stat().st_size
        timings.tile_size = tile_size
        timings.total_tiles = sum(
            entry["tile_rows"] * entry["tile_columns"]
            for entry in tile_data["rasters"].values()
        )

    dependencies = {
        "rasterio": rasterio,
        "exact_extract": exact_extract,
        "json_feature_source": JSONFeatureSource,
        "rasterio_raster_source": RasterioRasterSource,
        "raster_source_base": RasterSource,
        "mask_raster": mask_raster,
        "window_type": Window,
        "window_bounds": window_bounds,
        "box": box,
    }
    shape_geometries = [read_geometry(shape["geometry"]) for shape in shapes]
    populations = [0.0 for _ in shapes]
    jobs: list[tuple[RasterIndexEntry, list[int]]] = []

    intersection_started_at = time.perf_counter()
    for raster_entry in raster_index:
        raster_extent = box(*raster_entry.bounds)
        relevant_indices = [
            index
            for index, geometry in enumerate(shape_geometries)
            if geometry.intersects(raster_extent)
        ]
        timings.raster_intersection_checks += len(shape_geometries)
        if relevant_indices:
            jobs.append((raster_entry, relevant_indices))
    timings.raster_intersection_ms = (
        time.perf_counter() - intersection_started_at
    ) * 1_000
    timings.selected_raster_count = len(jobs)

    timings.concurrent_worker_count = bounded_worker_count(len(jobs))
    concurrent_processing_started_at = time.perf_counter()

    def run_job(job: tuple[RasterIndexEntry, list[int]]) -> RasterWorkResult:
        entry, relevant_indices = job
        if method == "fractional":
            if tile_data is None:
                raise RuntimeError("Tile index was not initialized.")
            return process_tiled_raster(
                entry,
                tile_data["rasters"][entry.path.name],
                tile_size,
                shapes,
                shape_geometries,
                relevant_indices,
                dependencies,
            )
        return process_binary_raster(
            entry,
            shapes,
            relevant_indices,
            method,
            dependencies,
        )

    if not jobs:
        work_results: list[RasterWorkResult] = []
    elif timings.concurrent_worker_count == 1:
        work_results = [run_job(jobs[0])]
    else:
        with ThreadPoolExecutor(max_workers=timings.concurrent_worker_count) as executor:
            futures = [executor.submit(run_job, job) for job in jobs]
            work_results = [future.result() for future in futures]
    timings.concurrent_processing_ms = (
        time.perf_counter() - concurrent_processing_started_at
    ) * 1_000

    results_by_raster = {
        work_result.timing.name: work_result for work_result in work_results
    }
    for raster_entry in raster_index:
        work_result = results_by_raster.get(raster_entry.path.name)
        if work_result is None:
            continue
        timings.raster_timings.append(work_result.timing)
        for shape_index, population in work_result.contributions:
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
    ]
    if timings.tile_index_path:
        index_status = "rebuilt" if timings.tile_index_rebuilt else "loaded"
        lines.append(
            f"  tile index: {timings.tile_index_ms:.1f} ms "
            f"({index_status}; build {timings.tile_index_build_ms:.1f} ms; "
            f"{timings.tile_size}px; {timings.total_tiles} tiles; "
            f"{timings.tile_index_size} bytes)"
        )
        lines.append(f"    {timings.tile_index_path}")
    lines.append(
        f"  polygon/raster intersections: {timings.raster_intersection_ms:.1f} ms "
        f"({timings.raster_intersection_checks} checks, "
        f"{timings.selected_raster_count} selected rasters)"
    )
    lines.append(
        f"  concurrent raster processing: {timings.concurrent_processing_ms:.1f} ms "
        f"({len(timings.raster_timings)} rasters, "
        f"{timings.concurrent_worker_count} workers)"
    )

    total_inside = 0
    total_boundary_tiles = 0
    total_boundary_shape_matches = 0
    total_boundary_pixels = 0
    for raster_timing in timings.raster_timings:
        total_inside += raster_timing.fully_inside_tile_matches
        total_boundary_tiles += raster_timing.boundary_tiles
        total_boundary_shape_matches += raster_timing.boundary_shape_matches
        total_boundary_pixels += raster_timing.boundary_pixels
        lines.append(
            f"    {raster_timing.name}: open {raster_timing.open_ms:.1f} ms; "
            f"classify {raster_timing.classification_ms:.1f} ms "
            f"({raster_timing.classification_checks} checks); "
            f"inside {raster_timing.fully_inside_tile_matches}; "
            f"boundary {raster_timing.boundary_tiles} tiles/"
            f"{raster_timing.boundary_shape_matches} shape matches/"
            f"{raster_timing.boundary_pixels} pixels; "
            f"{raster_timing.extraction_method} {raster_timing.extraction_ms:.1f} ms; "
            f"{raster_timing.shape_count} shapes"
        )
    if timings.tile_index_path:
        lines.append(
            f"  tiled totals: {total_inside} fully-inside tile matches; "
            f"{total_boundary_tiles} boundary tiles; "
            f"{total_boundary_shape_matches} boundary shape matches; "
            f"{total_boundary_pixels} exact pixels"
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
        if arguments.tile_size <= 0:
            raise ValueError("--tile-size must be positive.")
        shapes = read_shapes()
        results = calculate_population(
            Path(arguments.raster).expanduser().resolve(),
            shapes,
            arguments.method,
            arguments.tile_size,
            Path(arguments.tile_index_root).expanduser().resolve(),
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
