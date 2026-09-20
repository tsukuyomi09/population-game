"""Shared lifecycle for generated population tile-total indexes."""

from __future__ import annotations

import gzip
import json
import math
import os
from pathlib import Path
import time
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_INDEX_ROOT = ROOT / "artifacts" / "population" / "tile-index"
DEFAULT_TILE_SIZE = 512
INDEX_VERSION = 1
RASTER_PATTERN = "*_pop_2026_CN_100m_R2025A_v1.tif"


def discover_raster_paths(source: Path) -> list[Path]:
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


def masked_sum(values: Any) -> float:
    return float(values.sum(dtype="float64")) if values.count() else 0.0


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
    if tile_size <= 0:
        raise ValueError("Tile size must be positive.")
    started_at = time.perf_counter()
    rasters: dict[str, Any] = {}

    for raster_path in raster_paths:
        with rasterio.open(raster_path) as raster:
            if raster.count != 1 or raster.crs is None or raster.crs.to_epsg() != 4326:
                raise ValueError(f"Expected a single-band EPSG:4326 raster: {raster_path}")
            if raster.nodata is None:
                raise ValueError(f"Expected a declared nodata value: {raster_path}")
            if raster.scales[0] != 1.0 or raster.offsets[0] != 0.0:
                raise ValueError(f"Scaled rasters are not supported: {raster_path}")

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
                    total = masked_sum(raster.read(1, window=window, masked=True))
                    if not math.isfinite(total) or total < 0:
                        raise ValueError(
                            f"Invalid population total {total} in {raster_path}"
                        )
                    totals.append(total)

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
    try:
        with gzip.open(temporary_path, "wt", encoding="utf-8", compresslevel=6) as index_file:
            json.dump(index, index_file, allow_nan=False, separators=(",", ":"))
        os.replace(temporary_path, output_path)
    finally:
        try:
            temporary_path.unlink(missing_ok=True)
        except OSError:
            pass
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
        tile_rows = entry.get("tile_rows")
        tile_columns = entry.get("tile_columns")
        totals = entry.get("totals")
        width = entry.get("width")
        height = entry.get("height")
        if (
            entry.get("size") != fingerprint["size"]
            or entry.get("mtime_ns") != fingerprint["mtime_ns"]
            or not isinstance(width, int)
            or width <= 0
            or not isinstance(height, int)
            or height <= 0
            or not isinstance(tile_rows, int)
            or tile_rows != math.ceil(height / tile_size)
            or not isinstance(tile_columns, int)
            or tile_columns != math.ceil(width / tile_size)
            or not isinstance(totals, list)
            or len(totals) != tile_rows * tile_columns
            or any(
                not isinstance(total, (int, float))
                or isinstance(total, bool)
                or not math.isfinite(total)
                or total < 0
                for total in totals
            )
        ):
            return False
    return True


def try_load_current_index(
    path: Path,
    raster_paths: list[Path],
    tile_size: int,
) -> dict[str, Any] | None:
    try:
        index = load_index(path)
    except (EOFError, OSError, ValueError, json.JSONDecodeError):
        return None
    return index if index_is_current(index, raster_paths, tile_size) else None


def prepare_index(
    raster_paths: list[Path],
    output_path: Path,
    tile_size: int,
    rebuild: bool,
    rasterio: Any,
    window_type: Any,
) -> tuple[dict[str, Any], float, bool]:
    if not rebuild:
        existing = try_load_current_index(output_path, raster_paths, tile_size)
        if existing is not None:
            return existing, 0.0, False

    output_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = output_path.with_name(f"{output_path.name}.lock")
    with lock_path.open("a+", encoding="utf-8") as lock_file:
        try:
            import fcntl
        except ImportError:
            fcntl = None
        if fcntl is not None:
            fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)

        if not rebuild:
            existing = try_load_current_index(output_path, raster_paths, tile_size)
            if existing is not None:
                return existing, 0.0, False

        index, seconds = build_index(
            raster_paths,
            output_path,
            tile_size,
            rasterio,
            window_type,
        )
        return index, seconds, True
