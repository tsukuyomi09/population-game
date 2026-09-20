#!/usr/bin/env python3
"""Evaluate area thresholds for fractional versus center boundary extraction."""

from __future__ import annotations

import argparse
import csv
from dataclasses import dataclass
import math
import os
from pathlib import Path
import statistics
import sys
from typing import Any

from adaptive_boundary_benchmark import (
    BenchmarkCase,
    BoundaryTile,
    MethodRun,
    TilePlan,
    benchmark_method,
    run_center,
    run_fractional,
)
from tile_index import (
    DEFAULT_INDEX_ROOT,
    DEFAULT_TILE_SIZE,
    ROOT,
    discover_raster_paths,
    index_path,
    prepare_index,
    tile_window,
)


DEFAULT_RASTER_DIRECTORY = ROOT / "data" / "population"
DEFAULT_REPETITIONS = 3
DEFAULT_OUTPUT = ROOT / "artifacts" / "population" / "area-threshold-benchmark.csv"
EQUAL_AREA_CRS = "EPSG:3035"
WGS84_CRS = "EPSG:4326"
TARGET_AREAS_KM2 = (
    0.01,
    0.05,
    0.25,
    0.5,
    1.0,
    5.0,
    10.0,
    25.0,
    50.0,
    100.0,
    500.0,
    1_000.0,
    2_500.0,
)


@dataclass(frozen=True)
class Location:
    identifier: str
    longitude: float
    latitude: float
    geometry_kind: str
    base_rotation: float


LOCATIONS = (
    Location("milan-square", 9.1900, 45.4642, "square", 11.0),
    Location("paris-circle", 2.3522, 48.8566, "circle", 0.0),
    Location("madrid-thin", -3.7038, 40.4168, "thin", 29.0),
    Location("berlin-irregular", 13.4050, 52.5200, "irregular", 17.0),
    Location("amsterdam-diamond", 4.9041, 52.3676, "diamond", 0.0),
    Location("rome-concave", 12.4964, 41.9028, "concave", 23.0),
    Location("basilicata-rural", 15.7700, 40.5200, "irregular", 41.0),
    Location("swiss-alpine-thin", 8.1500, 46.7000, "thin", 67.0),
)


@dataclass(frozen=True)
class CatalogTile:
    boundary_tile: BoundaryTile
    extent: Any
    population: float


@dataclass(frozen=True)
class ThresholdCase:
    benchmark_case: BenchmarkCase
    location: Location
    target_area_km2: float
    measured_area_km2: float


@dataclass(frozen=True)
class ThresholdResult:
    case: ThresholdCase
    fractional: MethodRun
    center: MethodRun

    @property
    def absolute_difference(self) -> float:
        return abs(self.center.population - self.fractional.population)

    @property
    def percentage_difference(self) -> float:
        if self.fractional.population == 0:
            return 0.0 if self.absolute_difference == 0 else math.inf
        return self.absolute_difference / abs(self.fractional.population) * 100


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--raster",
        type=Path,
        default=Path(os.environ.get("POPULATION_RASTER_PATH", DEFAULT_RASTER_DIRECTORY)),
    )
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--index-root", type=Path, default=DEFAULT_INDEX_ROOT)
    parser.add_argument("--repetitions", type=int, default=DEFAULT_REPETITIONS)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Rebuild tile totals before benchmarking.",
    )
    return parser.parse_args()


def base_geometry(kind: str, dependencies: dict[str, Any]) -> Any:
    polygon = dependencies["polygon"]
    point = dependencies["point"]
    box = dependencies["geometry_box"]
    if kind == "square":
        return box(-0.5, -0.5, 0.5, 0.5)
    if kind == "circle":
        return point(0, 0).buffer(1, quad_segs=24)
    if kind == "thin":
        aspect = 8.0
        width = math.sqrt(aspect)
        height = 1 / width
        return box(-width / 2, -height / 2, width / 2, height / 2)
    if kind == "diamond":
        return polygon(((0, 1), (1, 0), (0, -1), (-1, 0), (0, 1)))
    if kind == "irregular":
        radii = (1.0, 0.58, 0.91, 0.67, 1.08, 0.52, 0.94, 0.63, 1.03, 0.56)
        coordinates = []
        for index, radius in enumerate(radii):
            angle = 2 * math.pi * index / len(radii)
            coordinates.append((math.cos(angle) * radius, math.sin(angle) * radius))
        coordinates.append(coordinates[0])
        return polygon(coordinates)
    if kind == "concave":
        return polygon(
            (
                (-1.0, -1.0),
                (1.0, -1.0),
                (1.0, -0.25),
                (0.15, -0.25),
                (0.15, 1.0),
                (-1.0, 1.0),
                (-1.0, -1.0),
            )
        )
    raise ValueError(f"Unknown geometry kind: {kind}")


def build_case(
    location: Location,
    target_area_km2: float,
    area_index: int,
    dependencies: dict[str, Any],
) -> ThresholdCase:
    projected = base_geometry(location.geometry_kind, dependencies)
    projected = dependencies["translate"](
        projected,
        xoff=-projected.centroid.x,
        yoff=-projected.centroid.y,
    )
    target_area_m2 = target_area_km2 * 1_000_000
    scale_factor = math.sqrt(target_area_m2 / projected.area)
    projected = dependencies["scale"](
        projected,
        xfact=scale_factor,
        yfact=scale_factor,
        origin=(0, 0),
    )
    projected = dependencies["rotate"](
        projected,
        location.base_rotation + area_index * 7.0,
        origin=(0, 0),
    )
    center_x, center_y = dependencies["transform"](
        WGS84_CRS,
        EQUAL_AREA_CRS,
        [location.longitude],
        [location.latitude],
    )
    projected = dependencies["translate"](
        projected,
        xoff=center_x[0],
        yoff=center_y[0],
    )
    geometry = dependencies["transform_geom"](
        EQUAL_AREA_CRS,
        WGS84_CRS,
        dependencies["mapping"](projected),
        precision=15,
    )
    wgs84_polygon = dependencies["shape"](geometry)
    measured_geometry = dependencies["transform_geom"](
        WGS84_CRS,
        EQUAL_AREA_CRS,
        geometry,
        precision=15,
    )
    measured_area_km2 = dependencies["shape"](measured_geometry).area / 1_000_000
    if wgs84_polygon.is_empty or not wgs84_polygon.is_valid:
        raise ValueError(f"Generated invalid case for {location.identifier}.")

    area_label = f"{target_area_km2:g}".replace(".", "p")
    identifier = f"{area_label}km2-{location.identifier}"
    benchmark_case = BenchmarkCase(
        identifier=identifier,
        scale=f"{target_area_km2:g} km2",
        geometry=geometry,
        polygon=wgs84_polygon,
    )
    return ThresholdCase(
        benchmark_case=benchmark_case,
        location=location,
        target_area_km2=target_area_km2,
        measured_area_km2=measured_area_km2,
    )


def build_catalog(
    raster_paths: list[Path],
    tile_index: dict[str, Any],
    tile_size: int,
    dependencies: dict[str, Any],
) -> tuple[CatalogTile, ...]:
    catalog: list[CatalogTile] = []
    for raster_path in raster_paths:
        entry = tile_index["rasters"][raster_path.name]
        with dependencies["rasterio"].open(raster_path) as raster:
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
                    offset = tile_row * entry["tile_columns"] + tile_column
                    catalog.append(
                        CatalogTile(
                            boundary_tile=BoundaryTile(raster_path, window),
                            extent=extent,
                            population=float(entry["totals"][offset]),
                        )
                    )
    return tuple(catalog)


def build_plan(case: BenchmarkCase, catalog: tuple[CatalogTile, ...]) -> TilePlan:
    inside_population = 0.0
    inside_tiles = 0
    boundary_population_upper_bound = 0.0
    boundary_tiles: list[BoundaryTile] = []
    for tile in catalog:
        if not case.polygon.intersects(tile.extent):
            continue
        if case.polygon.covers(tile.extent):
            inside_population += tile.population
            inside_tiles += 1
        else:
            boundary_population_upper_bound += tile.population
            boundary_tiles.append(tile.boundary_tile)
    return TilePlan(
        inside_population=inside_population,
        inside_tiles=inside_tiles,
        boundary_population_upper_bound=boundary_population_upper_bound,
        boundary_tiles=tuple(boundary_tiles),
    )


def percentile_95(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * 0.95) - 1)]


def format_percentage(value: float) -> str:
    return "inf" if not math.isfinite(value) else f"{value:.6f}"


def write_csv(results: list[ThresholdResult], output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="") as output_file:
        writer = csv.DictWriter(
            output_file,
            fieldnames=(
                "case",
                "location",
                "geometry",
                "target_area_km2",
                "measured_area_km2",
                "fractional_population",
                "center_population",
                "absolute_difference",
                "percentage_difference",
                "fractional_runtime_ms",
                "center_runtime_ms",
            ),
        )
        writer.writeheader()
        for result in results:
            writer.writerow(
                {
                    "case": result.case.benchmark_case.identifier,
                    "location": result.case.location.identifier,
                    "geometry": result.case.location.geometry_kind,
                    "target_area_km2": result.case.target_area_km2,
                    "measured_area_km2": result.case.measured_area_km2,
                    "fractional_population": result.fractional.population,
                    "center_population": result.center.population,
                    "absolute_difference": result.absolute_difference,
                    "percentage_difference": result.percentage_difference,
                    "fractional_runtime_ms": result.fractional.seconds * 1_000,
                    "center_runtime_ms": result.center.seconds * 1_000,
                }
            )


def print_results(results: list[ThresholdResult], repetitions: int) -> None:
    print(
        "case                                  area km2     fractional        center  "
        "abs difference   difference %  fractional ms  center ms"
    )
    print("-" * 137)
    for result in results:
        print(
            f"{result.case.benchmark_case.identifier:<36} "
            f"{result.case.measured_area_km2:>10.4f} "
            f"{result.fractional.population:>14,.6f} "
            f"{result.center.population:>13,.6f} "
            f"{result.absolute_difference:>15,.6f} "
            f"{format_percentage(result.percentage_difference):>14} "
            f"{result.fractional.seconds * 1_000:>13.1f} "
            f"{result.center.seconds * 1_000:>10.1f}"
        )

    print(f"\nRuntimes are medians of {repetitions} measured runs after one warm-up.")
    print("\nError distribution by target area")
    print(
        "area km2  cases   median %      p95 %      max %   <=0.1%  <=0.01%  "
        "median fractional ms  median center ms"
    )
    print("-" * 111)
    for target_area in TARGET_AREAS_KM2:
        group = [result for result in results if result.case.target_area_km2 == target_area]
        errors = [result.percentage_difference for result in group]
        fractional_ms = [result.fractional.seconds * 1_000 for result in group]
        center_ms = [result.center.seconds * 1_000 for result in group]
        print(
            f"{target_area:>8,g} "
            f"{len(group):>6} "
            f"{statistics.median(errors):>10.6f} "
            f"{percentile_95(errors):>10.6f} "
            f"{max(errors):>10.6f} "
            f"{sum(error <= 0.1 for error in errors):>8}/{len(group):<2} "
            f"{sum(error <= 0.01 for error in errors):>8}/{len(group):<2} "
            f"{statistics.median(fractional_ms):>21.1f} "
            f"{statistics.median(center_ms):>16.1f}"
        )

    print("\nObserved threshold candidates")
    for tolerance in (0.1, 0.01):
        candidate = None
        candidate_count = 0
        candidate_max = math.inf
        for target_area in TARGET_AREAS_KM2:
            eligible = [
                result
                for result in results
                if result.case.target_area_km2 >= target_area
            ]
            worst = max(result.percentage_difference for result in eligible)
            if worst <= tolerance:
                candidate = target_area
                candidate_count = len(eligible)
                candidate_max = worst
                break
        if candidate is None:
            print(f"  {tolerance:g}%: none in this dataset")
        else:
            print(
                f"  {tolerance:g}%: {candidate:g} km2 observed cutoff "
                f"({candidate_count} polygons at/above it; worst {candidate_max:.6f}%)"
            )


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
        from rasterio.warp import transform, transform_geom
        from rasterio.windows import Window, bounds as window_bounds
        from shapely.affinity import rotate, scale, translate
        from shapely.geometry import Point, Polygon, box as geometry_box, mapping, shape
    except ImportError:
        print(
            "Benchmark error: install tools/population/requirements.txt first.",
            file=sys.stderr,
        )
        return 1

    try:
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
            "box": geometry_box,
            "geometry_box": geometry_box,
            "point": Point,
            "polygon": Polygon,
            "mapping": mapping,
            "shape": shape,
            "rotate": rotate,
            "scale": scale,
            "translate": translate,
            "transform": transform,
            "transform_geom": transform_geom,
        }
        cases = [
            build_case(location, target_area, area_index, dependencies)
            for area_index, target_area in enumerate(TARGET_AREAS_KM2)
            for location in LOCATIONS
        ]
        catalog = build_catalog(
            raster_paths,
            tile_index,
            arguments.tile_size,
            dependencies,
        )

        results: list[ThresholdResult] = []
        for index, case in enumerate(cases, start=1):
            print(
                f"Benchmarking {index}/{len(cases)} {case.benchmark_case.identifier}...",
                file=sys.stderr,
                flush=True,
            )
            plan = build_plan(case.benchmark_case, catalog)
            if not plan.boundary_tiles and plan.inside_tiles == 0:
                raise ValueError(
                    f"Case {case.benchmark_case.identifier!r} intersects no raster."
                )
            fractional_method = lambda: run_fractional(
                case.benchmark_case,
                plan,
                dependencies,
            )
            center_method = lambda: run_center(
                case.benchmark_case,
                plan,
                dependencies,
            )
            fractional_method()
            center_method()
            fractional = benchmark_method(fractional_method, arguments.repetitions)
            center = benchmark_method(center_method, arguments.repetitions)
            results.append(ThresholdResult(case, fractional, center))

        print(
            f"Tile index: {output_path} "
            f"({'rebuilt' if rebuilt else 'reused'}, {preprocessing_seconds:.3f} s)"
        )
        print(f"Cases: {len(results)}; tile size: {arguments.tile_size}\n")
        csv_path = arguments.output.expanduser().resolve()
        write_csv(results, csv_path)
        print_results(results, arguments.repetitions)
        print(f"\nDetailed CSV: {csv_path}")
        return 0
    except Exception as error:
        print(f"Benchmark error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
