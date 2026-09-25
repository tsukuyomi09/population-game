"""Reusable local-raster population calculation engine."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
import math
import os
from pathlib import Path
from threading import Lock
import time
from typing import Any

from tile_index import (
    discover_raster_paths,
    index_path,
    prepare_index,
    tile_window,
)


EXPECTED_RESOLUTION_DEGREES = 1 / 1200
METHODS = ("fractional", "center")
MAX_RASTER_WORKERS = 4
CENTER_MASK_LOCK = Lock()


@dataclass(frozen=True)
class RasterIndexEntry:
    path: Path
    bounds: tuple[float, float, float, float]


@dataclass(frozen=True)
class RasterTiming:
    name: str
    shape_count: int
    total_ms: float
    open_ms: float
    tile_count: int
    tile_setup_ms: float
    classification_ms: float
    classification_checks: int
    fully_inside_tile_matches: int
    inside_aggregation_ms: float
    boundary_tiles: int
    boundary_shape_matches: int
    boundary_pixels: int
    extraction_method: str
    extraction_ms: float
    center_read_ms: float
    center_mask_ms: float
    center_sum_ms: float


@dataclass(frozen=True)
class RasterWorkResult:
    contributions: list[tuple[int, float]]
    timing: RasterTiming


@dataclass
class PopulationTimings:
    calculation_method: str = ""
    total_calculation_ms: float = 0.0
    geometry_creation_ms: float = 0.0
    result_aggregation_ms: float = 0.0
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


def validate_shapes(values: Any) -> list[dict[str, Any]]:
    if not isinstance(values, list):
        raise ValueError("Input must contain a shapes array.")

    shapes: list[dict[str, Any]] = []
    for index, value in enumerate(values):
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
                raise ValueError(
                    f"Shape {index} ring {ring_index} must have at least four positions."
                )
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
                    raise ValueError(
                        f"Shape {index} contains invalid WGS84 coordinates."
                    )
        shapes.append(value)

    return shapes


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
    timings: PopulationTimings,
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


def extract_center_population(
    raster: Any,
    window: Any,
    shapes: list[dict[str, Any]],
    relevant_indices: list[int],
    geometry_mask: Any,
    numpy: Any,
) -> tuple[list[tuple[int, float]], float]:
    extraction_started_at = time.perf_counter()

    read_started_at = time.perf_counter()
    values = raster.read(1, window=window, masked=True)
    nodata_mask = numpy.ma.getmaskarray(values)
    read_ms = (time.perf_counter() - read_started_at) * 1_000

    mask_ms = 0.0
    sum_ms = 0.0
    contributions: list[tuple[int, float]] = []

    for shape_index in relevant_indices:
        # Rasterio's GDAL-backed rasterizer shares process-global state. Serialize
        # these short mask operations while raster reads remain concurrent.
        mask_started_at = time.perf_counter()

        with CENTER_MASK_LOCK:
            selected = geometry_mask(
                [shapes[shape_index]["geometry"]],
                out_shape=(int(window.height), int(window.width)),
                transform=raster.window_transform(window),
                all_touched=False,
                invert=True,
            )

        mask_ms += (time.perf_counter() - mask_started_at) * 1_000

        sum_started_at = time.perf_counter()

        selected_values = numpy.ma.array(
            values.data,
            mask=nodata_mask | ~selected,
            copy=False,
        )
        population = (
            float(selected_values.sum(dtype="float64"))
            if selected_values.count()
            else 0.0
        )

        sum_ms += (time.perf_counter() - sum_started_at) * 1_000

        contributions.append((shape_index, population))

    return (
        contributions,
        (time.perf_counter() - extraction_started_at) * 1_000,
        read_ms,
        mask_ms,
        sum_ms,
    )

def process_tiled_raster(
    entry: RasterIndexEntry,
    tile_entry: dict[str, Any],
    tile_size: int,
    shapes: list[dict[str, Any]],
    shape_geometries: list[Any],
    relevant_indices: list[int],
    method: str,
    dependencies: dict[str, Any],
) -> RasterWorkResult:
    raster_total_started_at = time.perf_counter()

    raster_open_started_at = time.perf_counter()
    raster = dependencies["rasterio"].open(entry.path)
    raster_open_ms = (time.perf_counter() - raster_open_started_at) * 1_000

    raster_populations = {index: 0.0 for index in relevant_indices}

    tile_count = 0
    tile_setup_ms = 0.0
    classification_ms = 0.0
    classification_checks = 0
    fully_inside_tile_matches = 0
    inside_aggregation_ms = 0.0
    boundary_tiles = 0
    boundary_shape_matches = 0
    boundary_pixels = 0
    extraction_ms = 0.0

    center_read_ms = 0.0
    center_mask_ms = 0.0
    center_sum_ms = 0.0

    try:
        if tile_entry["width"] != raster.width or tile_entry["height"] != raster.height:
            raise RuntimeError(f"Tile index dimensions do not match raster {entry.path}")

        totals = tile_entry["totals"]

        for tile_row in range(tile_entry["tile_rows"]):
            for tile_column in range(tile_entry["tile_columns"]):
                tile_count += 1

                tile_setup_started_at = time.perf_counter()

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

                tile_setup_ms += (
                    time.perf_counter() - tile_setup_started_at
                ) * 1_000

                boundary_indices: list[int] = []

                classification_started_at = time.perf_counter()

                for shape_index in relevant_indices:
                    classification_checks += 1
                    geometry = shape_geometries[shape_index]

                    if not geometry.intersects(extent):
                        continue

                    if geometry.covers(extent):
                        inside_started_at = time.perf_counter()

                        total_offset = (
                            tile_row * tile_entry["tile_columns"] + tile_column
                        )

                        raster_populations[shape_index] += float(
                            totals[total_offset]
                        )

                        fully_inside_tile_matches += 1

                        inside_aggregation_ms += (
                            time.perf_counter() - inside_started_at
                        ) * 1_000

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

                if method == "fractional":
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

                else:
                    (
                        contributions,
                        tile_extraction_ms,
                        tile_read_ms,
                        tile_mask_ms,
                        tile_sum_ms,
                    ) = extract_center_population(
                        raster,
                        window,
                        shapes,
                        boundary_indices,
                        dependencies["geometry_mask"],
                        dependencies["numpy"],
                    )

                    center_read_ms += tile_read_ms
                    center_mask_ms += tile_mask_ms
                    center_sum_ms += tile_sum_ms

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
            total_ms=(time.perf_counter() - raster_total_started_at) * 1_000,
            open_ms=raster_open_ms,
            tile_count=tile_count,
            tile_setup_ms=tile_setup_ms,
            classification_ms=classification_ms,
            classification_checks=classification_checks,
            fully_inside_tile_matches=fully_inside_tile_matches,
            inside_aggregation_ms=inside_aggregation_ms,
            boundary_tiles=boundary_tiles,
            boundary_shape_matches=boundary_shape_matches,
            boundary_pixels=boundary_pixels,
            extraction_method="exactextract" if method == "fractional" else "center",
            extraction_ms=extraction_ms,
            center_read_ms=center_read_ms,
            center_mask_ms=center_mask_ms,
            center_sum_ms=center_sum_ms,
        ),
    )


class PopulationEngine:
    """Population calculator with process-lifetime raster metadata and tile totals."""

    def __init__(
        self,
        raster_source_path: Path,
        tile_size: int,
        tile_index_root: Path,
    ) -> None:
        if tile_size <= 0:
            raise ValueError("Tile size must be positive.")

        self.raster_source_path = raster_source_path.expanduser().resolve()
        self.tile_size = tile_size
        self.tile_index_root = tile_index_root.expanduser().resolve()
        self.initialization_timings = PopulationTimings()

        dependency_import_started_at = time.perf_counter()
        try:
            import numpy
            import rasterio
            from exactextract import exact_extract
            from exactextract.feature import JSONFeatureSource
            from exactextract.raster import RasterioRasterSource, RasterSource
            from rasterio.features import geometry_mask
            from rasterio.windows import Window, bounds as window_bounds
            from shapely.geometry import box, shape as read_geometry
        except ImportError as error:
            raise RuntimeError(
                "Python geospatial dependencies are missing; "
                "install tools/population/requirements.txt."
            ) from error
        self.initialization_timings.dependency_import_ms = (
            time.perf_counter() - dependency_import_started_at
        ) * 1_000

        self.dependencies = {
            "rasterio": rasterio,
            "numpy": numpy,
            "exact_extract": exact_extract,
            "json_feature_source": JSONFeatureSource,
            "rasterio_raster_source": RasterioRasterSource,
            "raster_source_base": RasterSource,
            "geometry_mask": geometry_mask,
            "window_type": Window,
            "window_bounds": window_bounds,
            "box": box,
            "read_geometry": read_geometry,
        }
        self.raster_index = discover_rasters(
            self.raster_source_path,
            rasterio,
            self.initialization_timings,
        )
        raster_paths = [entry.path for entry in self.raster_index]

        tile_index_started_at = time.perf_counter()
        self.tile_index_file = index_path(self.tile_index_root, self.tile_size)
        self.tile_data, build_seconds, rebuilt = prepare_index(
            raster_paths,
            self.tile_index_file,
            self.tile_size,
            False,
            rasterio,
            Window,
        )
        self.initialization_timings.tile_index_ms = (
            time.perf_counter() - tile_index_started_at
        ) * 1_000
        self.initialization_timings.tile_index_build_ms = build_seconds * 1_000
        self.initialization_timings.tile_index_rebuilt = rebuilt
        self.initialization_timings.tile_index_path = str(self.tile_index_file)
        self.initialization_timings.tile_index_size = self.tile_index_file.stat().st_size
        self.initialization_timings.tile_size = self.tile_size
        self.initialization_timings.total_tiles = sum(
            entry["tile_rows"] * entry["tile_columns"]
            for entry in self.tile_data["rasters"].values()
        )
        self.raster_extents = {
            entry.path: box(*entry.bounds) for entry in self.raster_index
        }

    def calculate(
        self,
        shapes: list[dict[str, Any]],
        method: str,
        timings: PopulationTimings | None = None,
    ) -> list[dict[str, Any]]:
        calculation_started_at = time.perf_counter()

        if method not in METHODS:
            raise ValueError(f"Unsupported population calculation method: {method!r}")

        if timings is None:
            timings = PopulationTimings()
        timings.calculation_method = method
        self._copy_initialization_timings(timings)

        if not shapes:
            return []

        geometry_started_at = time.perf_counter()

        shape_geometries = [
            self.dependencies["read_geometry"](shape["geometry"]) for shape in shapes
        ]

        timings.geometry_creation_ms = (
            time.perf_counter() - geometry_started_at
        ) * 1_000
        populations = [0.0 for _ in shapes]
        jobs: list[tuple[RasterIndexEntry, list[int]]] = []

        intersection_started_at = time.perf_counter()
        for raster_entry in self.raster_index:
            raster_extent = self.raster_extents[raster_entry.path]
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
            return process_tiled_raster(
                entry,
                self.tile_data["rasters"][entry.path.name],
                self.tile_size,
                shapes,
                shape_geometries,
                relevant_indices,
                method,
                self.dependencies,
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

        result_aggregation_started_at = time.perf_counter()

        results_by_raster = {
            work_result.timing.name: work_result for work_result in work_results
        }

        for raster_entry in self.raster_index:
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
                raise RuntimeError(
                    f"Invalid population result for shape {shape_id!r}: {population}"
                )

            results.append({"id": shape_id, "population": population})

        timings.result_aggregation_ms = (
            time.perf_counter() - result_aggregation_started_at
        ) * 1_000

        timings.total_calculation_ms = (
            time.perf_counter() - calculation_started_at
        ) * 1_000

        if os.getenv("POPULATION_PROFILE") == "1":
            print("\n=== POPULATION PROFILE ===", flush=True)
            print(f"method: {timings.calculation_method}", flush=True)
            print(f"total: {timings.total_calculation_ms:.2f} ms", flush=True)
            print(f"geometry: {timings.geometry_creation_ms:.2f} ms", flush=True)
            print(
                f"rasters: {timings.selected_raster_count} selected / "
                f"{timings.discovered_raster_count} total",
                flush=True,
            )
            print(
                f"raster intersection: {timings.raster_intersection_ms:.2f} ms "
                f"({timings.raster_intersection_checks} checks)",
                flush=True,
            )
            print(
                f"concurrent processing: {timings.concurrent_processing_ms:.2f} ms "
                f"with {timings.concurrent_worker_count} workers",
                flush=True,
            )
            print(
                f"result aggregation: {timings.result_aggregation_ms:.2f} ms",
                flush=True,
            )

            for r in timings.raster_timings:
                print(
                    f"\n[{r.name}]\n"
                    f"  total: {r.total_ms:.2f} ms\n"
                    f"  open: {r.open_ms:.2f} ms\n"
                    f"  tiles visited: {r.tile_count}\n"
                    f"  tile setup: {r.tile_setup_ms:.2f} ms\n"
                    f"  classification: {r.classification_ms:.2f} ms\n"
                    f"  classification checks: {r.classification_checks}\n"
                    f"  fully inside: {r.fully_inside_tile_matches}\n"
                    f"  inside aggregation: {r.inside_aggregation_ms:.2f} ms\n"
                    f"  boundary tiles: {r.boundary_tiles}\n"
                    f"  boundary pixels: {r.boundary_pixels}\n"
                    f"  extraction ({r.extraction_method}): {r.extraction_ms:.2f} ms\n"
                    f"  center read: {r.center_read_ms:.2f} ms\n"
                    f"  center mask: {r.center_mask_ms:.2f} ms\n"
                    f"  center sum: {r.center_sum_ms:.2f} ms",
                    flush=True,
                )

            print("=== END PROFILE ===\n", flush=True)

        return results

    def _copy_initialization_timings(self, timings: PopulationTimings) -> None:
        initialization = self.initialization_timings
        timings.dependency_import_ms = initialization.dependency_import_ms
        timings.raster_discovery_ms = initialization.raster_discovery_ms
        timings.raster_metadata_index_ms = initialization.raster_metadata_index_ms
        timings.discovered_raster_count = initialization.discovered_raster_count
        timings.tile_index_ms = initialization.tile_index_ms
        timings.tile_index_build_ms = initialization.tile_index_build_ms
        timings.tile_index_rebuilt = initialization.tile_index_rebuilt
        timings.tile_index_path = initialization.tile_index_path
        timings.tile_index_size = initialization.tile_index_size
        timings.tile_size = initialization.tile_size
        timings.total_tiles = initialization.total_tiles
