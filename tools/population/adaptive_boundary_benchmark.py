#!/usr/bin/env python3
"""Compare fractional and center rules on tiled boundary windows."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import statistics
import sys
import time
from typing import Any, Callable

from benchmark import benchmark_fractional, masked_sum
from tile_index import (
    DEFAULT_INDEX_ROOT,
    DEFAULT_TILE_SIZE,
    ROOT,
    discover_raster_paths,
    index_path,
    prepare_index,
    tile_window,
)


DEFAULT_CASES = Path(__file__).parent / "fixtures" / "adaptive-boundary-polygons.json"
DEFAULT_RASTER_DIRECTORY = ROOT / "data" / "population"
DEFAULT_REPETITIONS = 3


@dataclass(frozen=True)
class BenchmarkCase:
    identifier: str
    scale: str
    geometry: dict[str, Any]
    polygon: Any


@dataclass(frozen=True)
class BoundaryTile:
    raster_path: Path
    window: Any


@dataclass(frozen=True)
class TilePlan:
    inside_population: float
    inside_tiles: int
    boundary_population_upper_bound: float
    boundary_tiles: tuple[BoundaryTile, ...]


@dataclass(frozen=True)
class MethodRun:
    population: float
    boundary_population: float
    seconds: float


@dataclass(frozen=True)
class CaseResult:
    case: BenchmarkCase
    plan: TilePlan
    fractional: MethodRun
    center: MethodRun


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument(
        "--raster",
        type=Path,
        default=Path(os.environ.get("POPULATION_RASTER_PATH", DEFAULT_RASTER_DIRECTORY)),
    )
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--index-root", type=Path, default=DEFAULT_INDEX_ROOT)
    parser.add_argument("--repetitions", type=int, default=DEFAULT_REPETITIONS)
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Rebuild tile totals before benchmarking.",
    )
    return parser.parse_args()


def load_cases(path: Path, read_geometry: Callable[[dict[str, Any]], Any]) -> list[BenchmarkCase]:
    with path.expanduser().open(encoding="utf-8") as cases_file:
        document = json.load(cases_file)
    if not isinstance(document, dict) or document.get("type") != "FeatureCollection":
        raise ValueError("Cases must be a GeoJSON FeatureCollection.")
    features = document.get("features")
    if not isinstance(features, list) or not features:
        raise ValueError("Cases must contain at least one feature.")

    cases: list[BenchmarkCase] = []
    identifiers: set[str] = set()
    for index, feature in enumerate(features):
        if not isinstance(feature, dict) or feature.get("type") != "Feature":
            raise ValueError(f"Case {index} must be a GeoJSON Feature.")
        identifier = feature.get("id")
        properties = feature.get("properties")
        geometry = feature.get("geometry")
        scale = properties.get("scale") if isinstance(properties, dict) else None
        if not isinstance(identifier, str) or not identifier or identifier in identifiers:
            raise ValueError(f"Case {index} must have a unique string ID.")
        if not isinstance(scale, str) or not scale:
            raise ValueError(f"Case {identifier!r} must declare properties.scale.")
        if not isinstance(geometry, dict) or geometry.get("type") != "Polygon":
            raise ValueError(f"Case {identifier!r} must contain a Polygon.")
        polygon = read_geometry(geometry)
        if polygon.is_empty or not polygon.is_valid:
            raise ValueError(f"Case {identifier!r} must be non-empty and valid.")
        identifiers.add(identifier)
        cases.append(BenchmarkCase(identifier, scale, geometry, polygon))
    return cases


def build_tile_plan(
    case: BenchmarkCase,
    raster_paths: list[Path],
    tile_index: dict[str, Any],
    tile_size: int,
    dependencies: dict[str, Any],
) -> TilePlan:
    inside_population = 0.0
    inside_tiles = 0
    boundary_population_upper_bound = 0.0
    boundary_tiles: list[BoundaryTile] = []

    for raster_path in raster_paths:
        entry = tile_index["rasters"][raster_path.name]
        totals = entry["totals"]
        with dependencies["rasterio"].open(raster_path) as raster:
            raster_extent = dependencies["box"](*raster.bounds)
            if not case.polygon.intersects(raster_extent):
                continue
            for tile_row in range(entry["tile_rows"]):
                for tile_column in range(entry["tile_columns"]):
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
                    if not case.polygon.intersects(extent):
                        continue
                    offset = tile_row * entry["tile_columns"] + tile_column
                    tile_population = float(totals[offset])
                    if case.polygon.covers(extent):
                        inside_population += tile_population
                        inside_tiles += 1
                    else:
                        boundary_population_upper_bound += tile_population
                        boundary_tiles.append(BoundaryTile(raster_path, window))

    return TilePlan(
        inside_population=inside_population,
        inside_tiles=inside_tiles,
        boundary_population_upper_bound=boundary_population_upper_bound,
        boundary_tiles=tuple(boundary_tiles),
    )


def run_fractional(
    case: BenchmarkCase,
    plan: TilePlan,
    dependencies: dict[str, Any],
) -> MethodRun:
    started_at = time.perf_counter()
    boundary_population = 0.0
    current_path: Path | None = None
    raster: Any = None
    try:
        for boundary_tile in plan.boundary_tiles:
            if boundary_tile.raster_path != current_path:
                if raster is not None:
                    raster.close()
                current_path = boundary_tile.raster_path
                raster = dependencies["rasterio"].open(current_path)
            result = benchmark_fractional(
                raster,
                boundary_tile.window,
                case.geometry,
                dependencies["exact_extract"],
                dependencies["json_feature_source"],
                dependencies["rasterio_raster_source"],
                dependencies["raster_source_base"],
                dependencies["window_bounds"],
            )
            boundary_population += result.population or 0.0
    finally:
        if raster is not None:
            raster.close()
    return MethodRun(
        population=plan.inside_population + boundary_population,
        boundary_population=boundary_population,
        seconds=time.perf_counter() - started_at,
    )


def run_center(
    case: BenchmarkCase,
    plan: TilePlan,
    dependencies: dict[str, Any],
) -> MethodRun:
    started_at = time.perf_counter()
    boundary_population = 0.0
    current_path: Path | None = None
    raster: Any = None
    try:
        for boundary_tile in plan.boundary_tiles:
            if boundary_tile.raster_path != current_path:
                if raster is not None:
                    raster.close()
                current_path = boundary_tile.raster_path
                raster = dependencies["rasterio"].open(current_path)
            values = raster.read(1, window=boundary_tile.window, masked=True)
            selected = dependencies["geometry_mask"](
                [case.geometry],
                out_shape=(int(boundary_tile.window.height), int(boundary_tile.window.width)),
                transform=raster.window_transform(boundary_tile.window),
                all_touched=False,
                invert=True,
            )
            values.mask = values.mask | ~selected
            boundary_population += masked_sum(values)
    finally:
        if raster is not None:
            raster.close()
    return MethodRun(
        population=plan.inside_population + boundary_population,
        boundary_population=boundary_population,
        seconds=time.perf_counter() - started_at,
    )


def benchmark_method(
    method: Callable[[], MethodRun],
    repetitions: int,
) -> MethodRun:
    runs = [method() for _ in range(repetitions)]
    reference = runs[0]
    if any(
        not math.isclose(run.population, reference.population, rel_tol=0, abs_tol=1e-7)
        for run in runs[1:]
    ):
        raise RuntimeError("Repeated benchmark runs returned different populations.")
    return MethodRun(
        population=reference.population,
        boundary_population=reference.boundary_population,
        seconds=statistics.median(run.seconds for run in runs),
    )


def percentage(numerator: float, denominator: float) -> float:
    return 0.0 if denominator == 0 else numerator / denominator * 100


def print_report(results: list[CaseResult], repetitions: int) -> None:
    print(
        "case                     fractional       center       abs diff   diff %  "
        "frac ms  center ms  boundary tiles  boundary estimate  estimate ratio"
    )
    print("-" * 145)
    for result in results:
        difference = abs(result.center.population - result.fractional.population)
        estimated_total = (
            result.plan.inside_population
            + result.plan.boundary_population_upper_bound
        )
        estimate_ratio = percentage(
            result.plan.boundary_population_upper_bound,
            estimated_total,
        )
        print(
            f"{result.case.identifier:<24} "
            f"{result.fractional.population:>14,.3f} "
            f"{result.center.population:>12,.3f} "
            f"{difference:>14,.3f} "
            f"{percentage(difference, result.fractional.population):>8.6f} "
            f"{result.fractional.seconds * 1_000:>8.1f} "
            f"{result.center.seconds * 1_000:>10.1f} "
            f"{len(result.plan.boundary_tiles):>15,} "
            f"{result.plan.boundary_population_upper_bound:>18,.3f} "
            f"{estimate_ratio:>13.6f}%"
        )

    print(f"\nMethod runtimes are medians of {repetitions} measured runs after one warm-up.")
    print(
        "Boundary estimate is the precomputed population of each complete "
        "intersecting boundary tile."
    )
    print(
        "Estimate ratio = boundary estimate / (fully-inside population + "
        "boundary estimate); it is an index-only conservative signal."
    )
    print("\nBoundary signal detail")
    for result in results:
        actual_ratio = percentage(
            result.fractional.boundary_population,
            result.fractional.population,
        )
        center_boundary_ratio = percentage(
            result.center.boundary_population,
            result.center.population,
        )
        print(
            f"  {result.case.identifier}: inside {result.plan.inside_tiles:,} tiles/"
            f"{result.plan.inside_population:,.3f}; "
            f"fractional boundary {result.fractional.boundary_population:,.3f} "
            f"({actual_ratio:.6f}% of total); "
            f"center boundary {result.center.boundary_population:,.3f} "
            f"({center_boundary_ratio:.6f}% of total)"
        )
    print("\nAdaptive policy: no threshold applied; measurements only.")


def main() -> int:
    arguments = parse_arguments()
    if arguments.tile_size <= 0 or arguments.repetitions <= 0:
        print("Benchmark error: tile size and repetitions must be positive.", file=sys.stderr)
        return 1

    try:
        import rasterio
        from exactextract import exact_extract
        from exactextract.feature import JSONFeatureSource
        from exactextract.raster import RasterioRasterSource, RasterSource
        from rasterio.features import geometry_mask
        from rasterio.windows import Window, bounds as window_bounds
        from shapely.geometry import box, shape
    except ImportError:
        print(
            "Benchmark error: install tools/population/requirements.txt first.",
            file=sys.stderr,
        )
        return 1

    try:
        cases = load_cases(arguments.cases, shape)
        raster_paths = discover_raster_paths(arguments.raster)
        output_path = index_path(arguments.index_root.expanduser().resolve(), arguments.tile_size)
        tile_index, preprocessing_seconds, rebuilt = prepare_index(
            raster_paths,
            output_path,
            arguments.tile_size,
            arguments.rebuild,
            rasterio,
            Window,
        )
        dependencies = {
            "rasterio": rasterio,
            "exact_extract": exact_extract,
            "json_feature_source": JSONFeatureSource,
            "rasterio_raster_source": RasterioRasterSource,
            "raster_source_base": RasterSource,
            "geometry_mask": geometry_mask,
            "window_type": Window,
            "window_bounds": window_bounds,
            "box": box,
        }

        results: list[CaseResult] = []
        for case in cases:
            print(f"Planning {case.identifier}...", file=sys.stderr, flush=True)
            plan = build_tile_plan(
                case,
                raster_paths,
                tile_index,
                arguments.tile_size,
                dependencies,
            )
            if not plan.boundary_tiles and plan.inside_tiles == 0:
                raise ValueError(f"Case {case.identifier!r} intersects no population raster.")

            run_fractional_case = lambda: run_fractional(case, plan, dependencies)
            run_center_case = lambda: run_center(case, plan, dependencies)
            run_fractional_case()
            run_center_case()
            fractional = benchmark_method(run_fractional_case, arguments.repetitions)
            center = benchmark_method(run_center_case, arguments.repetitions)
            results.append(CaseResult(case, plan, fractional, center))

        print(
            f"Tile index: {output_path} "
            f"({'rebuilt' if rebuilt else 'reused'}, {preprocessing_seconds:.3f} s)"
        )
        print(f"Tile size: {arguments.tile_size} x {arguments.tile_size} pixels\n")
        print_report(results, arguments.repetitions)
        return 0
    except Exception as error:
        print(f"Benchmark error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
