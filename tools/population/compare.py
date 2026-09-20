#!/usr/bin/env python3
"""Compare the live WorldPop-backed API with the local raster worker."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_FIXTURES = Path(__file__).parent / "fixtures" / "italy-polygons.json"
DEFAULT_WORKER = Path(__file__).parent / "worker.py"
DEFAULT_RASTER = ROOT / "data" / "population" / "ita_pop_2026_CN_100m_R2025A_v1.tif"
METHODS = ("fractional", "center", "all-touched")
FOCUS_SHAPE_IDS = {"small-milan", "fractional-pixel-bologna"}


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api-url", default="http://localhost:3000/api/population")
    parser.add_argument(
        "--raster",
        default=os.environ.get("POPULATION_RASTER_PATH", str(DEFAULT_RASTER)),
    )
    parser.add_argument("--fixtures", type=Path, default=DEFAULT_FIXTURES)
    parser.add_argument("--worker", type=Path, default=DEFAULT_WORKER)
    parser.add_argument("--timeout", type=float, default=420)
    return parser.parse_args()


def load_payload(path: Path) -> dict[str, Any]:
    with path.open(encoding="utf-8") as fixture_file:
        payload = json.load(fixture_file)
    if not isinstance(payload, dict) or not isinstance(payload.get("shapes"), list):
        raise ValueError(f"Fixture file must contain a shapes array: {path}")
    return payload


def run_local_worker(
    worker_path: Path,
    raster_path: Path,
    payload: dict[str, Any],
    timeout: float,
    method: str,
) -> list[dict[str, Any]]:
    completed = subprocess.run(
        [
            sys.executable,
            str(worker_path),
            "--raster",
            str(raster_path),
            "--method",
            method,
        ],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or "Local worker failed without diagnostics.")
    result = json.loads(completed.stdout)
    if not isinstance(result, list):
        raise ValueError("Local worker returned a non-array result.")
    return result


def run_worldpop_api(
    api_url: str,
    payload: dict[str, Any],
    timeout: float,
) -> list[dict[str, Any]]:
    request = Request(
        api_url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=timeout) as response:
            result = json.load(response)
    except HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Population API returned HTTP {error.code}: {body}") from error
    except URLError as error:
        raise RuntimeError(f"Could not reach {api_url}: {error.reason}") from error

    results = result.get("results") if isinstance(result, dict) else None
    if not isinstance(results, list):
        raise ValueError("Population API response does not contain a results array.")
    return results


def id_key(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def format_number(value: float) -> str:
    return f"{value:,.3f}"


def print_method_summary(
    title: str,
    metrics: dict[str, list[tuple[float, float | None]]],
) -> None:
    print(f"\n{title}:")
    print("method       total absolute difference  mean percentage difference")
    print("-----------  -------------------------  --------------------------")
    for method in METHODS:
        values = metrics[method]
        total_absolute = sum(absolute for absolute, _ in values)
        percentages = [percentage for _, percentage in values if percentage is not None]
        mean_percentage = sum(percentages) / len(percentages) if percentages else None
        percentage_text = "n/a" if mean_percentage is None else f"{mean_percentage:.3f}%"
        print(f"{method.ljust(11)}  {format_number(total_absolute).rjust(25)}  {percentage_text.rjust(26)}")


def report(
    shapes: list[dict[str, Any]],
    worldpop_results: list[dict[str, Any]],
    local_results: dict[str, list[dict[str, Any]]],
) -> None:
    worldpop_by_id = {id_key(result["id"]): result for result in worldpop_results}
    local_by_method = {
        method: {id_key(result["id"]): result for result in results}
        for method, results in local_results.items()
    }
    rows: list[tuple[str, str, str, str, str, str]] = []
    closest: list[tuple[str, str, float]] = []
    all_metrics: dict[str, list[tuple[float, float | None]]] = {
        method: [] for method in METHODS
    }
    focus_metrics: dict[str, list[tuple[float, float | None]]] = {
        method: [] for method in METHODS
    }

    for shape in shapes:
        shape_id = shape["id"]
        key = id_key(shape_id)
        if key not in worldpop_by_id:
            raise ValueError(f"Missing comparison result for {shape_id!r}.")

        worldpop = float(worldpop_by_id[key]["population"])
        method_differences: list[tuple[str, float]] = []
        for method in METHODS:
            if key not in local_by_method[method]:
                raise ValueError(f"Missing {method} result for {shape_id!r}.")
            local = float(local_by_method[method][key]["population"])
            absolute = abs(local - worldpop)
            percentage_value = (
                None if worldpop == 0 else absolute / abs(worldpop) * 100
            )
            percentage = "0.000%" if worldpop == 0 and local == 0 else (
                "n/a" if percentage_value is None else f"{percentage_value:.3f}%"
            )
            metric = (absolute, percentage_value)
            all_metrics[method].append(metric)
            if shape_id in FOCUS_SHAPE_IDS:
                focus_metrics[method].append(metric)
            rows.append(
                (
                    str(shape_id),
                    method,
                    format_number(worldpop),
                    format_number(local),
                    format_number(absolute),
                    percentage,
                )
            )
            method_differences.append((method, absolute))
        closest.append((str(shape_id), *min(method_differences, key=lambda item: item[1])))

    headers = (
        "polygon",
        "method",
        "WorldPop",
        "local",
        "abs difference",
        "% difference",
    )
    widths = [
        max(len(headers[index]), *(len(row[index]) for row in rows))
        for index in range(len(headers))
    ]
    print("  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)))
    print("  ".join("-" * width for width in widths))
    for row in rows:
        print("  ".join(value.ljust(widths[index]) for index, value in enumerate(row)))

    print("\nClosest local method by absolute difference:")
    for shape_id, method, difference in closest:
        print(f"- {shape_id}: {method} ({format_number(difference)})")

    print_method_summary("All fixture polygons", all_metrics)
    print_method_summary("Boundary-sensitive polygons", focus_metrics)


def main() -> int:
    arguments = parse_arguments()
    try:
        payload = load_payload(arguments.fixtures)
        local_results = {}
        for method in METHODS:
            print(f"Running local raster worker ({method})...", file=sys.stderr)
            local_results[method] = run_local_worker(
                arguments.worker,
                Path(arguments.raster).expanduser().resolve(),
                payload,
                arguments.timeout,
                method,
            )
        print("Requesting WorldPop oracle through /api/population...", file=sys.stderr)
        worldpop_results = run_worldpop_api(
            arguments.api_url,
            payload,
            arguments.timeout,
        )
        report(payload["shapes"], worldpop_results, local_results)
        return 0
    except Exception as error:
        print(f"Comparison failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
