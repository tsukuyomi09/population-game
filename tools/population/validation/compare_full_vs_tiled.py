#!/usr/bin/env python3
"""Compare full exactextract with the production tiled fractional calculation."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import sys
import time
from typing import Any

ROOT = Path(__file__).resolve().parents[3]
POPULATION_TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(POPULATION_TOOLS))

from tile_index import (
    DEFAULT_INDEX_ROOT,
    DEFAULT_TILE_SIZE,
    discover_raster_paths,
    index_path,
    load_index,
    prepare_index,
    tile_window,
)


DEFAULT_POLYGON = Path(__file__).parent / "fixtures" / "europe-large-polygon.json"
DEFAULT_RASTER_DIRECTORY = ROOT / "data" / "population"


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


def select_geometry(document: Any, shape_id: str | None) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise ValueError("Polygon input must be a JSON object.")

    candidates: list[tuple[Any, Any]]
    document_type = document.get("type")
    if document_type == "Polygon":
        candidates = [(None, document)]
    elif document_type == "Feature":
        candidates = [(document.get("id"), document.get("geometry"))]
    elif document_type == "FeatureCollection":
        features = document.get("features")
        if not isinstance(features, list):
            raise ValueError("GeoJSON FeatureCollection must contain a features array.")
        candidates = [
            (feature.get("id"), feature.get("geometry"))
            for feature in features
            if isinstance(feature, dict)
        ]
    elif isinstance(document.get("shapes"), list):
        candidates = [
            (shape.get("id"), shape.get("geometry"))
            for shape in document["shapes"]
            if isinstance(shape, dict)
        ]
    else:
        raise ValueError(
            "Input must be a GeoJSON Polygon/Feature/FeatureCollection or an "
            "/api/population request payload."
        )

    if shape_id is not None:
        candidates = [candidate for candidate in candidates if str(candidate[0]) == shape_id]
        if len(candidates) != 1:
            raise ValueError(f"Expected exactly one shape with id {shape_id!r}.")
    elif len(candidates) != 1:
        raise ValueError("Input contains multiple shapes; provide --shape-id.")

    geometry = candidates[0][1]
    if not isinstance(geometry, dict) or geometry.get("type") != "Polygon":
        raise ValueError("The selected geometry must be a GeoJSON Polygon.")
    return geometry


def load_geometry(path: Path, shape_id: str | None) -> dict[str, Any]:
    if str(path) == "-":
        document = json.load(sys.stdin)
    else:
        with path.expanduser().open(encoding="utf-8") as polygon_file:
            document = json.load(polygon_file)
    return select_geometry(document, shape_id)


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
    raster: Any,
    window: Any,
    geometry: dict[str, Any],
    dependencies: dict[str, Any],
) -> float:
    source = make_windowed_raster_source(
        raster,
        window,
        dependencies["rasterio_raster_source"],
        dependencies["raster_source_base"],
        dependencies["window_bounds"],
    )
    vector = dependencies["json_feature_source"](
        [{"type": "Feature", "properties": {}, "geometry": geometry}],
        srs_wkt=raster.crs.to_wkt(),
    )
    extracted = dependencies["exact_extract"](
        source,
        vector,
        "population=sum(default_value=0)",
        progress=False,
    )
    if len(extracted) != 1:
        raise RuntimeError("exactextract returned an unexpected number of results.")
    value = extracted[0].get("properties", {}).get("population")
    return 0.0 if value is None else float(value)


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
            population += extract_fractional_population(
                raster, window, geometry, dependencies
            )
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
                    population += extract_fractional_population(
                        raster, window, geometry, dependencies
                    )

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
