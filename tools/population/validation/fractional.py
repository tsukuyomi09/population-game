"""Offline exact-fractional population calculation for validation scripts."""

from __future__ import annotations

from pathlib import Path
import sys
from typing import Any


POPULATION_TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(POPULATION_TOOLS))

from engine import validate_raster, validate_shapes  # noqa: E402
from tile_index import discover_raster_paths  # noqa: E402


def calculate_fractional_population(
    raster_source_path: Path,
    submitted_shapes: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Calculate exact fractional coverage outside the production engine."""
    try:
        import rasterio
        from exactextract import exact_extract
        from exactextract.feature import JSONFeatureSource
        from exactextract.raster import RasterioRasterSource
        from shapely.geometry import box, shape as read_geometry
    except ImportError as error:
        raise RuntimeError(
            "Validation dependencies are missing; install "
            "tools/population/validation/requirements.txt."
        ) from error

    shapes = validate_shapes(submitted_shapes)
    geometries = [read_geometry(value["geometry"]) for value in shapes]
    populations = [0.0 for _ in shapes]

    for raster_path in discover_raster_paths(raster_source_path):
        with rasterio.open(raster_path) as raster:
            validate_raster(raster, raster_path)
            raster_extent = box(
                raster.bounds.left,
                raster.bounds.bottom,
                raster.bounds.right,
                raster.bounds.top,
            )
            relevant_indices = [
                index
                for index, geometry in enumerate(geometries)
                if geometry.intersects(raster_extent)
            ]
            if not relevant_indices:
                continue

            features = [
                {
                    "type": "Feature",
                    "properties": {"shape_index": index},
                    "geometry": shapes[index]["geometry"],
                }
                for index in relevant_indices
            ]
            vector = JSONFeatureSource(features, srs_wkt=raster.crs.to_wkt())
            extracted = exact_extract(
                RasterioRasterSource(raster),
                vector,
                "population=sum(default_value=0)",
                include_cols=["shape_index"],
                progress=False,
            )
            if len(extracted) != len(relevant_indices):
                raise RuntimeError(
                    "exactextract returned an unexpected number of results."
                )

            for output_index, feature in enumerate(extracted):
                properties = feature.get("properties", {})
                shape_index = properties.get("shape_index")
                expected_shape_index = relevant_indices[output_index]
                if shape_index != expected_shape_index:
                    raise RuntimeError(
                        "exactextract did not preserve the submitted shape index."
                    )
                population = properties.get("population")
                if population is not None:
                    populations[expected_shape_index] += float(population)

    return [
        {"id": shape["id"], "population": populations[index]}
        for index, shape in enumerate(shapes)
    ]
