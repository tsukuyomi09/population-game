#!/usr/bin/env python3
"""Calculate population sums for a JSON batch from stdin."""

from __future__ import annotations

import argparse
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


@dataclass(frozen=True)
class RasterIndexEntry:
    path: Path
    bounds: tuple[float, float, float, float]


@dataclass(frozen=True)
class RasterTiming:
    name: str
    shape_count: int
    open_ms: float
    extraction_method: str
    extraction_ms: float


@dataclass
class WorkerTimings:
    dependency_import_ms: float = 0.0
    raster_discovery_ms: float = 0.0
    raster_metadata_index_ms: float = 0.0
    intersection_checks_ms: float = 0.0
    intersection_check_count: int = 0
    discovered_raster_count: int = 0
    selected_raster_count: int = 0
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
) -> list[RasterIndexEntry]:
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


def add_fractional_population(
    raster: Any,
    shapes: list[dict[str, Any]],
    relevant_indices: list[int],
    populations: list[float],
    exact_extract: Any,
    json_feature_source: Any,
) -> float:
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

    for output_index, feature in enumerate(extracted):
        properties = feature.get("properties", {})
        shape_index = properties.get("shape_index")
        expected_shape_index = relevant_indices[output_index]
        if shape_index != expected_shape_index:
            raise RuntimeError("exactextract did not preserve the submitted shape index.")
        population_value = properties.get("population")
        if population_value is not None:
            populations[expected_shape_index] += float(population_value)

    return extraction_ms


def add_binary_population(
    raster: Any,
    shapes: list[dict[str, Any]],
    relevant_indices: list[int],
    populations: list[float],
    method: str,
    mask_raster: Any,
) -> float:
    extraction_started_at = time.perf_counter()
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
            continue
        if selected.count():
            populations[shape_index] += float(selected.sum(dtype="float64"))

    return (time.perf_counter() - extraction_started_at) * 1_000


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

    raster_index = discover_rasters(raster_source_path, rasterio, timings)
    shape_geometries = [read_geometry(shape["geometry"]) for shape in shapes]
    populations = [0.0 for _ in shapes]

    for raster_entry in raster_index:
        intersection_started_at = time.perf_counter()
        raster_extent = box(*raster_entry.bounds)
        relevant_indices = [
            index
            for index, geometry in enumerate(shape_geometries)
            if geometry.intersects(raster_extent)
        ]
        timings.intersection_checks_ms += (
            time.perf_counter() - intersection_started_at
        ) * 1_000
        timings.intersection_check_count += len(shape_geometries)
        if not relevant_indices:
            continue
        timings.selected_raster_count += 1

        raster_open_started_at = time.perf_counter()
        raster = rasterio.open(raster_entry.path)
        raster_open_ms = (time.perf_counter() - raster_open_started_at) * 1_000
        try:
            # Discovery already validated metadata; each selected raster is opened
            # once more to process every intersecting shape in this batch.
            validate_raster(raster, raster_entry.path)
            if method == "fractional":
                extraction_ms = add_fractional_population(
                    raster,
                    shapes,
                    relevant_indices,
                    populations,
                    exact_extract,
                    JSONFeatureSource,
                )
                extraction_method = "exactextract"
            else:
                extraction_ms = add_binary_population(
                    raster,
                    shapes,
                    relevant_indices,
                    populations,
                    method,
                    mask_raster,
                )
                extraction_method = method
        finally:
            raster.close()

        timings.raster_timings.append(
            RasterTiming(
                name=raster_entry.path.name,
                shape_count=len(relevant_indices),
                open_ms=raster_open_ms,
                extraction_method=extraction_method,
                extraction_ms=extraction_ms,
            )
        )

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
            f"  polygon/raster intersections: {timings.intersection_checks_ms:.1f} ms "
            f"({timings.intersection_check_count} checks, "
            f"{timings.selected_raster_count} selected rasters)"
        ),
    ]
    for raster_timing in timings.raster_timings:
        lines.append(
            f"  {raster_timing.name}: open {raster_timing.open_ms:.1f} ms; "
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
