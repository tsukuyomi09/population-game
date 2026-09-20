#!/usr/bin/env python3
"""Benchmark exact population extraction with preaggregated raster tiles."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import gzip
import json
import math
import os
from pathlib import Path
import sys
import time
from typing import Any

from benchmark import (
    DEFAULT_POLYGON,
    DEFAULT_RASTER_DIRECTORY,
    benchmark_fractional,
    discover_rasters,
    load_geometry,
    masked_sum,
)


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INDEX_ROOT = ROOT / "artifacts" / "population" / "tile-index"
INDEX_VERSION = 1
DEFAULT_TILE_SIZE = 256


@dataclass(frozen=True)
class FullResult:
    population: float
    seconds: float
    pixels: int
    relevant_rasters: int


@dataclass(frozen=True)
class TiledResult:
    population: float
    seconds: float
    fully_inside_tiles: int
    boundary_tiles: int
    boundary_pixels: int
    relevant_rasters: int


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--polygon", type=Path, default=DEFAULT_POLYGON)
    parser.add_argument("--shape-id")
    parser.add_argument(
        "--raster",
        type=Path,
        default=Path(os.environ.get("POPULATION_RASTER_PATH", DEFAULT_RASTER_DIRECTORY)),
    )
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--index-root", type=Path, default=DEFAULT_INDEX_ROOT)
    parser.add_argument(
        "--rebuild",
        action="store_true",
        help="Rebuild tile totals even when a compatible generated index exists.",
    )
    return parser.parse_args()


def tile_window(
    tile_row: int,
    tile_column: int,
    tile_size: int,
    raster_width: int,
    raster_height: int,
    window_type: Any,
) -> Any:
    row_off = tile_row * tile_size
    column_off = tile_column * tile_size
    return window_type(
        column_off,
        row_off,
        min(tile_size, raster_width - column_off),
        min(tile_size, raster_height - row_off),
    )


def index_path(index_root: Path, tile_size: int) -> Path:
    return index_root / f"population-tiles-{tile_size}.json.gz"


def raster_fingerprint(path: Path) -> dict[str, int]:
    stat = path.stat()
    return {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}


def build_index(
    raster_paths: list[Path],
    output_path: Path,
    tile_size: int,
    rasterio: Any,
    window_type: Any,
) -> tuple[dict[str, Any], float]:
    started_at = time.perf_counter()
    rasters: dict[str, Any] = {}

    for raster_path in raster_paths:
        print(f"Preaggregating {raster_path.name}...", file=sys.stderr, flush=True)
        with rasterio.open(raster_path) as raster:
            if raster.count != 1 or raster.crs is None or raster.crs.to_epsg() != 4326:
                raise ValueError(f"Expected a single-band EPSG:4326 raster: {raster_path}")
            if raster.scales[0] != 1.0 or raster.offsets[0] != 0.0:
                raise ValueError(f"Scaled rasters are not supported by this spike: {raster_path}")

            tile_rows = math.ceil(raster.height / tile_size)
            tile_columns = math.ceil(raster.width / tile_size)
            totals: list[float] = []
            for tile_row in range(tile_rows):
                for tile_column in range(tile_columns):
                    window = tile_window(
                        tile_row,
                        tile_column,
                        tile_size,
                        raster.width,
                        raster.height,
                        window_type,
                    )
                    totals.append(masked_sum(raster.read(1, window=window, masked=True)))

            rasters[raster_path.name] = {
                **raster_fingerprint(raster_path),
                "width": raster.width,
                "height": raster.height,
                "tile_rows": tile_rows,
                "tile_columns": tile_columns,
                "totals": totals,
            }

    index = {
        "version": INDEX_VERSION,
        "tile_size": tile_size,
        "rasters": rasters,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = output_path.with_name(f"{output_path.name}.{os.getpid()}.tmp")
    with gzip.open(temporary_path, "wt", encoding="utf-8", compresslevel=6) as index_file:
        json.dump(index, index_file, allow_nan=False, separators=(",", ":"))
    os.replace(temporary_path, output_path)
    return index, time.perf_counter() - started_at


def load_index(path: Path) -> dict[str, Any]:
    with gzip.open(path, "rt", encoding="utf-8") as index_file:
        index = json.load(index_file)
    if not isinstance(index, dict) or not isinstance(index.get("rasters"), dict):
        raise ValueError(f"Invalid generated tile index: {path}")
    return index


def index_is_current(
    index: dict[str, Any],
    raster_paths: list[Path],
    tile_size: int,
) -> bool:
    if index.get("version") != INDEX_VERSION or index.get("tile_size") != tile_size:
        return False
    indexed_rasters = index.get("rasters")
    if not isinstance(indexed_rasters, dict) or set(indexed_rasters) != {
        path.name for path in raster_paths
    }:
        return False
    for path in raster_paths:
        entry = indexed_rasters.get(path.name)
        if not isinstance(entry, dict):
            return False
        fingerprint = raster_fingerprint(path)
        if entry.get("size") != fingerprint["size"] or entry.get("mtime_ns") != fingerprint["mtime_ns"]:
            return False
    return True


def prepare_index(
    raster_paths: list[Path],
    output_path: Path,
    tile_size: int,
    rebuild: bool,
    rasterio: Any,
    window_type: Any,
) -> tuple[dict[str, Any], float, bool]:
    if not rebuild and output_path.is_file():
        existing = load_index(output_path)
        if index_is_current(existing, raster_paths, tile_size):
            return existing, 0.0, False
    index, seconds = build_index(
        raster_paths,
        output_path,
        tile_size,
        rasterio,
        window_type,
    )
    return index, seconds, True


def relevant_window(raster: Any, geometry: dict[str, Any], geometry_window: Any, window_error: Any) -> Any | None:
    try:
        return geometry_window(raster, [geometry]).round_offsets().round_lengths()
    except window_error:
        return None


def run_full_exactextract(
    raster_paths: list[Path],
    geometry: dict[str, Any],
    dependencies: dict[str, Any],
) -> FullResult:
    started_at = time.perf_counter()
    population = 0.0
    pixels = 0
    relevant_rasters = 0
    for raster_path in raster_paths:
        with dependencies["rasterio"].open(raster_path) as raster:
            window = relevant_window(
                raster,
                geometry,
                dependencies["geometry_window"],
                dependencies["window_error"],
            )
            if window is None:
                continue
            relevant_rasters += 1
            pixels += int(window.width) * int(window.height)
            result = benchmark_fractional(
                raster,
                window,
                geometry,
                dependencies["exact_extract"],
                dependencies["json_feature_source"],
                dependencies["rasterio_raster_source"],
                dependencies["raster_source_base"],
                dependencies["window_bounds"],
            )
            population += result.population or 0.0
    return FullResult(
        population=population,
        seconds=time.perf_counter() - started_at,
        pixels=pixels,
        relevant_rasters=relevant_rasters,
    )


def run_tiled(
    raster_paths: list[Path],
    index_file: Path,
    geometry: dict[str, Any],
    polygon: Any,
    tile_size: int,
    dependencies: dict[str, Any],
) -> TiledResult:
    started_at = time.perf_counter()
    tile_index = load_index(index_file)
    population = 0.0
    fully_inside_tiles = 0
    boundary_tiles = 0
    boundary_pixels = 0
    relevant_rasters = 0

    for raster_path in raster_paths:
        entry = tile_index["rasters"][raster_path.name]
        totals = entry["totals"]
        with dependencies["rasterio"].open(raster_path) as raster:
            if relevant_window(
                raster,
                geometry,
                dependencies["geometry_window"],
                dependencies["window_error"],
            ) is None:
                continue
            relevant_rasters += 1
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
                    bounds = dependencies["window_bounds"](window, raster.transform)
                    extent = dependencies["box"](*bounds)
                    if not polygon.intersects(extent):
                        continue

                    tile_index_offset = tile_row * entry["tile_columns"] + tile_column
                    if polygon.covers(extent):
                        fully_inside_tiles += 1
                        population += float(totals[tile_index_offset])
                        continue

                    boundary_tiles += 1
                    boundary_pixels += int(window.width) * int(window.height)
                    result = benchmark_fractional(
                        raster,
                        window,
                        geometry,
                        dependencies["exact_extract"],
                        dependencies["json_feature_source"],
                        dependencies["rasterio_raster_source"],
                        dependencies["raster_source_base"],
                        dependencies["window_bounds"],
                    )
                    population += result.population or 0.0

    return TiledResult(
        population=population,
        seconds=time.perf_counter() - started_at,
        fully_inside_tiles=fully_inside_tiles,
        boundary_tiles=boundary_tiles,
        boundary_pixels=boundary_pixels,
        relevant_rasters=relevant_rasters,
    )


def main() -> int:
    arguments = parse_arguments()
    if arguments.tile_size <= 0:
        print("Benchmark error: --tile-size must be positive.", file=sys.stderr)
        return 1

    try:
        import rasterio
        from exactextract import exact_extract
        from exactextract.feature import JSONFeatureSource
        from exactextract.raster import RasterioRasterSource, RasterSource
        from rasterio.errors import WindowError
        from rasterio.features import geometry_window
        from rasterio.windows import Window, bounds as window_bounds
        from shapely.geometry import box, shape
    except ImportError:
        print(
            "Benchmark error: install tools/population/requirements.txt first.",
            file=sys.stderr,
        )
        return 1

    try:
        geometry = load_geometry(arguments.polygon, arguments.shape_id)
        polygon = shape(geometry)
        if polygon.is_empty or not polygon.is_valid:
            raise ValueError("The selected polygon must be non-empty and valid.")
        raster_paths = discover_rasters(arguments.raster)
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
            "window_error": WindowError,
            "geometry_window": geometry_window,
            "window_type": Window,
            "window_bounds": window_bounds,
            "box": box,
        }

        print("Running full exactextract baseline...", file=sys.stderr, flush=True)
        full = run_full_exactextract(raster_paths, geometry, dependencies)
        print("Running tiled calculation...", file=sys.stderr, flush=True)
        tiled = run_tiled(
            raster_paths,
            output_path,
            geometry,
            polygon,
            arguments.tile_size,
            dependencies,
        )

        total_tiles = sum(
            entry["tile_rows"] * entry["tile_columns"]
            for entry in tile_index["rasters"].values()
        )
        difference = tiled.population - full.population
        percentage_difference = (
            0.0 if full.population == 0 else abs(difference) / abs(full.population) * 100
        )
        speedup = full.seconds / tiled.seconds if tiled.seconds else math.inf

        print(f"Tile size: {arguments.tile_size} x {arguments.tile_size} pixels")
        print(
            f"Preprocessing: {preprocessing_seconds:.3f} s "
            f"({'rebuilt' if rebuilt else 'reused existing index'})"
        )
        print(f"Generated index: {output_path}")
        print(f"Generated index size: {output_path.stat().st_size:,} bytes")
        print(f"Total tiles: {total_tiles:,}")
        print(f"Relevant rasters: {tiled.relevant_rasters}")
        print(f"Fully-inside tiles: {tiled.fully_inside_tiles:,}")
        print(f"Boundary tiles: {tiled.boundary_tiles:,}")
        print(f"Full exactextract pixels: {full.pixels:,}")
        print(f"Boundary pixels requiring exactextract: {tiled.boundary_pixels:,}")
        print(f"Full exactextract population: {full.population:,.6f}")
        print(f"Tiled population: {tiled.population:,.6f}")
        print(f"Population difference: {difference:,.9f} ({percentage_difference:.9f}%)")
        print(f"Full exactextract runtime: {full.seconds:.3f} s")
        print(f"Tiled runtime: {tiled.seconds:.3f} s")
        print(f"Speedup: {speedup:.2f}x")
        return 0
    except Exception as error:
        print(f"Benchmark error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
