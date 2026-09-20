#!/usr/bin/env python3
"""Calculate population sums for a JSON batch from stdin."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import sys
import time

from engine import METHODS, PopulationEngine, PopulationTimings, validate_shapes
from tile_index import DEFAULT_INDEX_ROOT, DEFAULT_TILE_SIZE


WORKER_READY_MARKER = "__WORLDRAWING_POPULATION_WORKER_READY__"


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


def read_shapes() -> list[dict[str, Any]]:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict) or not isinstance(payload.get("shapes"), list):
        raise ValueError("Input must be a JSON object containing a shapes array.")
    return validate_shapes(payload["shapes"])


def write_timing_report(timings: PopulationTimings) -> None:
    lines = [
        "[population-worker timing]",
        f"  calculation mode: {timings.calculation_method}",
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
            f"{total_boundary_pixels} boundary pixels"
        )
    lines.append(f"  total worker (ready to result): {timings.total_worker_ms:.1f} ms")
    print("\n".join(lines), file=sys.stderr, flush=True)


def main() -> int:
    arguments = parse_arguments()
    print(WORKER_READY_MARKER, file=sys.stderr, flush=True)
    worker_started_at = time.perf_counter()
    timings = PopulationTimings(calculation_method=arguments.method)

    try:
        if not arguments.raster:
            raise ValueError("Provide --raster or set POPULATION_RASTER_PATH.")
        if arguments.tile_size <= 0:
            raise ValueError("--tile-size must be positive.")
        shapes = read_shapes()
        if shapes:
            engine = PopulationEngine(
                Path(arguments.raster),
                arguments.tile_size,
                Path(arguments.tile_index_root),
            )
            results = engine.calculate(shapes, arguments.method, timings)
        else:
            results = []
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
