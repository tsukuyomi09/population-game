#!/usr/bin/env python3
"""Benchmark population calculation paths for one polygon and many rasters."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path
import sys
import time
from typing import Any, Iterator


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_POLYGON = Path(__file__).parent / "fixtures" / "europe-large-polygon.json"
DEFAULT_RASTER_DIRECTORY = ROOT / "data" / "population"
RASTER_PATTERN = "*_pop_2026_CN_100m_R2025A_v1.tif"
DEFAULT_CHUNK_SIZE = 1024


@dataclass(frozen=True)
class MethodResult:
    seconds: float
    population: float | None


@dataclass(frozen=True)
class RasterBenchmark:
    name: str
    width: int
    height: int
    pixels: int
    raw_read: MethodResult
    raw_sum: MethodResult
    center: MethodResult
    all_touched: MethodResult
    fractional: MethodResult


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--polygon",
        type=Path,
        default=DEFAULT_POLYGON,
        help=(
            "GeoJSON Polygon, Feature, FeatureCollection, or /api/population request "
            f"payload (default: {DEFAULT_POLYGON.relative_to(ROOT)})."
        ),
    )
    parser.add_argument(
        "--shape-id",
        help="Select this shape ID when the input contains more than one shape.",
    )
    parser.add_argument(
        "--raster",
        type=Path,
        default=Path(os.environ.get("POPULATION_RASTER_PATH", DEFAULT_RASTER_DIRECTORY)),
        help="Population raster directory or one raster within it.",
    )
    parser.add_argument(
        "--chunk-size",
        type=int,
        default=DEFAULT_CHUNK_SIZE,
        help=f"Raster processing chunk width and height (default: {DEFAULT_CHUNK_SIZE}).",
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


def discover_rasters(source: Path) -> list[Path]:
    resolved = source.expanduser().resolve()
    if resolved.is_dir():
        directory = resolved
    elif resolved.is_file():
        directory = resolved.parent
    else:
        raise FileNotFoundError(f"Raster directory or file not found: {resolved}")

    paths = sorted(directory.glob(RASTER_PATTERN))
    if not paths:
        raise FileNotFoundError(
            f"No compatible rasters matching {RASTER_PATTERN} in {directory}"
        )
    return paths


def iter_chunk_windows(window: Any, chunk_size: int, window_type: Any) -> Iterator[Any]:
    row_start = int(window.row_off)
    row_stop = row_start + int(window.height)
    column_start = int(window.col_off)
    column_stop = column_start + int(window.width)
    for row_off in range(row_start, row_stop, chunk_size):
        height = min(chunk_size, row_stop - row_off)
        for column_off in range(column_start, column_stop, chunk_size):
            width = min(chunk_size, column_stop - column_off)
            yield window_type(column_off, row_off, width, height)


def masked_sum(values: Any) -> float:
    return float(values.sum(dtype="float64")) if values.count() else 0.0


def benchmark_raw_read_and_sum(
    raster: Any,
    chunks: list[Any],
) -> tuple[MethodResult, MethodResult]:
    read_seconds = 0.0
    sum_seconds = 0.0
    population = 0.0
    for chunk in chunks:
        started_at = time.perf_counter()
        values = raster.read(1, window=chunk, masked=True)
        read_seconds += time.perf_counter() - started_at

        started_at = time.perf_counter()
        population += masked_sum(values)
        sum_seconds += time.perf_counter() - started_at

    return (
        MethodResult(seconds=read_seconds, population=None),
        MethodResult(seconds=read_seconds + sum_seconds, population=population),
    )


def benchmark_masked_sum(
    raster: Any,
    chunks: list[Any],
    geometry: dict[str, Any],
    all_touched: bool,
    geometry_mask: Any,
) -> MethodResult:
    started_at = time.perf_counter()
    population = 0.0
    for chunk in chunks:
        values = raster.read(1, window=chunk, masked=True)
        selected = geometry_mask(
            [geometry],
            out_shape=(int(chunk.height), int(chunk.width)),
            transform=raster.window_transform(chunk),
            all_touched=all_touched,
            invert=True,
        )
        values.mask = values.mask | ~selected
        population += masked_sum(values)
    return MethodResult(seconds=time.perf_counter() - started_at, population=population)


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


def benchmark_fractional(
    raster: Any,
    window: Any,
    geometry: dict[str, Any],
    exact_extract: Any,
    json_feature_source: Any,
    rasterio_raster_source: Any,
    raster_source_base: Any,
    window_bounds: Any,
) -> MethodResult:
    source = make_windowed_raster_source(
        raster,
        window,
        rasterio_raster_source,
        raster_source_base,
        window_bounds,
    )
    vector = json_feature_source(
        [{"type": "Feature", "properties": {}, "geometry": geometry}],
        srs_wkt=raster.crs.to_wkt(),
    )
    started_at = time.perf_counter()
    extracted = exact_extract(
        source,
        vector,
        "population=sum(default_value=0)",
        progress=False,
    )
    elapsed = time.perf_counter() - started_at
    if len(extracted) != 1:
        raise RuntimeError("exactextract returned an unexpected number of results.")
    value = extracted[0].get("properties", {}).get("population")
    population = 0.0 if value is None else float(value)
    return MethodResult(seconds=elapsed, population=population)


def benchmark_raster(
    raster_path: Path,
    geometry: dict[str, Any],
    polygon: Any,
    chunk_size: int,
    dependencies: dict[str, Any],
) -> RasterBenchmark | None:
    rasterio = dependencies["rasterio"]
    with rasterio.open(raster_path) as raster:
        if raster.count != 1 or raster.crs is None or raster.crs.to_epsg() != 4326:
            raise ValueError(f"Expected a single-band EPSG:4326 raster: {raster_path}")
        raster_extent = dependencies["box"](
            raster.bounds.left,
            raster.bounds.bottom,
            raster.bounds.right,
            raster.bounds.top,
        )
        if not polygon.intersects(raster_extent):
            return None

        try:
            window = dependencies["geometry_window"](raster, [geometry])
        except dependencies["window_error"]:
            return None
        window = window.round_offsets().round_lengths()
        width = int(window.width)
        height = int(window.height)
        if width <= 0 or height <= 0:
            return None
        chunks = list(
            iter_chunk_windows(window, chunk_size, dependencies["window_type"])
        )

        raw_read, raw_sum = benchmark_raw_read_and_sum(raster, chunks)
        center = benchmark_masked_sum(
            raster,
            chunks,
            geometry,
            False,
            dependencies["geometry_mask"],
        )
        all_touched = benchmark_masked_sum(
            raster,
            chunks,
            geometry,
            True,
            dependencies["geometry_mask"],
        )
        fractional = benchmark_fractional(
            raster,
            window,
            geometry,
            dependencies["exact_extract"],
            dependencies["json_feature_source"],
            dependencies["rasterio_raster_source"],
            dependencies["raster_source_base"],
            dependencies["window_bounds"],
        )

    return RasterBenchmark(
        name=raster_path.name,
        width=width,
        height=height,
        pixels=width * height,
        raw_read=raw_read,
        raw_sum=raw_sum,
        center=center,
        all_touched=all_touched,
        fractional=fractional,
    )


def format_population(value: float | None) -> str:
    return "n/a" if value is None else f"{value:,.3f}"


def print_report(results: list[RasterBenchmark], total_seconds: float) -> None:
    for result in results:
        print(
            f"\n{result.name} "
            f"({result.width:,} x {result.height:,}; {result.pixels:,} pixels)"
        )
        rows = (
            ("raw window read", result.raw_read),
            ("raw sum", result.raw_sum),
            ("center mask + sum", result.center),
            ("all-touched mask + sum", result.all_touched),
            ("fractional exactextract", result.fractional),
        )
        for label, metric in rows:
            print(
                f"  {label:<27} {metric.seconds * 1_000:>10.1f} ms  "
                f"population {format_population(metric.population):>18}"
            )

    print("\nTotals")
    print("method                         time    population")
    print("---------------------------  --------  ------------------")
    for attribute, label in (
        ("raw_read", "raw window read"),
        ("raw_sum", "raw sum"),
        ("center", "center mask + sum"),
        ("all_touched", "all-touched mask + sum"),
        ("fractional", "fractional exactextract"),
    ):
        metrics = [getattr(result, attribute) for result in results]
        method_seconds = sum(metric.seconds for metric in metrics)
        populations = [metric.population for metric in metrics]
        population = None if any(value is None for value in populations) else sum(
            value for value in populations if value is not None
        )
        print(
            f"{label:<27}  {method_seconds * 1_000:>7.1f} ms  "
            f"{format_population(population):>18}"
        )
    print(f"\nRelevant rasters: {len(results)}")
    print(f"Approximate pixels per full method pass: {sum(r.pixels for r in results):,}")
    print(f"Whole benchmark wall time: {total_seconds:.3f} s")


def main() -> int:
    arguments = parse_arguments()
    if arguments.chunk_size <= 0:
        print("Benchmark error: --chunk-size must be positive.", file=sys.stderr)
        return 1

    try:
        dependency_started_at = time.perf_counter()
        import rasterio
        from exactextract import exact_extract
        from exactextract.feature import JSONFeatureSource
        from exactextract.raster import RasterioRasterSource, RasterSource
        from rasterio.errors import WindowError
        from rasterio.features import geometry_mask, geometry_window
        from rasterio.windows import Window, bounds as window_bounds
        from shapely.geometry import box, shape
        dependency_seconds = time.perf_counter() - dependency_started_at
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
        dependencies = {
            "rasterio": rasterio,
            "exact_extract": exact_extract,
            "json_feature_source": JSONFeatureSource,
            "rasterio_raster_source": RasterioRasterSource,
            "raster_source_base": RasterSource,
            "window_error": WindowError,
            "geometry_mask": geometry_mask,
            "geometry_window": geometry_window,
            "window_type": Window,
            "window_bounds": window_bounds,
            "box": box,
        }

        benchmark_started_at = time.perf_counter()
        results: list[RasterBenchmark] = []
        for raster_path in raster_paths:
            print(f"Benchmarking {raster_path.name}...", file=sys.stderr, flush=True)
            result = benchmark_raster(
                raster_path,
                geometry,
                polygon,
                arguments.chunk_size,
                dependencies,
            )
            if result is not None:
                results.append(result)
        benchmark_seconds = time.perf_counter() - benchmark_started_at
        if not results:
            raise ValueError("The polygon does not intersect any compatible raster.")

        print(f"Dependency import time: {dependency_seconds * 1_000:.1f} ms")
        print(f"Chunk size: {arguments.chunk_size} x {arguments.chunk_size}")
        print_report(results, benchmark_seconds)
        return 0
    except Exception as error:
        print(f"Benchmark error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
