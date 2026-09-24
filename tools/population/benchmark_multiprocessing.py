#!/usr/bin/env python3
"""Benchmark persistent PopulationEngine instances across spawned processes."""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing
import os
from pathlib import Path
import queue
import resource
import statistics
import sys
import time
from typing import Any

from engine import PopulationEngine, PopulationTimings
from tile_index import DEFAULT_TILE_SIZE


DEFAULT_REQUESTS = 400
DEFAULT_EIGHT_PROCESS_THRESHOLD = 1.5
WORKLOAD = [
    {
        "id": "multiprocessing-benchmark",
        "geometry": {
            "type": "Polygon",
            "coordinates": [
                [
                    [12.35, 41.8],
                    [12.65, 41.8],
                    [12.65, 42.02],
                    [12.35, 42.02],
                    [12.35, 41.8],
                ]
            ],
        },
    }
]
METHOD = "fractional"

_ENGINE: PopulationEngine | None = None


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--raster-path",
        type=Path,
        default=Path("data/population"),
    )
    parser.add_argument(
        "--index-root",
        type=Path,
        default=Path("artifacts/population/tile-index"),
    )
    parser.add_argument("--tile-size", type=int, default=DEFAULT_TILE_SIZE)
    parser.add_argument("--requests", type=int, default=DEFAULT_REQUESTS)
    parser.add_argument(
        "--eight-process-threshold",
        type=float,
        default=DEFAULT_EIGHT_PROCESS_THRESHOLD,
        help="Run eight processes only when 4-process RPS / 2-process RPS meets this value.",
    )
    arguments = parser.parse_args()
    if arguments.requests <= 0:
        parser.error("--requests must be positive")
    if arguments.tile_size <= 0:
        parser.error("--tile-size must be positive")
    if arguments.eight_process_threshold <= 1:
        parser.error("--eight-process-threshold must be greater than 1")
    return arguments


def max_rss_bytes() -> int:
    rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return int(rss if sys.platform == "darwin" else rss * 1024)


def initialize_worker(
    raster_path: str,
    tile_size: int,
    index_root: str,
    ready: Any,
) -> None:
    global _ENGINE
    _ENGINE = PopulationEngine(Path(raster_path), tile_size, Path(index_root))
    _ENGINE.calculate(WORKLOAD, METHOD)
    ready.put(os.getpid())


def calculate(_: int) -> dict[str, Any]:
    if _ENGINE is None:
        raise RuntimeError("Worker engine was not initialized.")

    timings = PopulationTimings()
    cpu_started_at = time.process_time()
    started_at = time.perf_counter()
    results = _ENGINE.calculate(WORKLOAD, METHOD, timings)
    latency_ms = (time.perf_counter() - started_at) * 1_000
    cpu_seconds = time.process_time() - cpu_started_at

    return {
        "pid": os.getpid(),
        "latencyMs": latency_ms,
        "cpuSeconds": cpu_seconds,
        "peakRssBytes": max_rss_bytes(),
        "classificationMs": sum(
            timing.classification_ms for timing in timings.raster_timings
        ),
        "extractionMs": sum(timing.extraction_ms for timing in timings.raster_timings),
        "population": results[0]["population"],
        "selectedRasterCount": timings.selected_raster_count,
        "rasterWorkerCount": timings.concurrent_worker_count,
    }


def percentile(values: list[float], requested: int) -> float:
    ordered = sorted(values)
    index = max(0, math.ceil((requested / 100) * len(ordered)) - 1)
    return ordered[index]


def timing_summary(values: list[float]) -> dict[str, float]:
    return {
        "mean": round(statistics.fmean(values), 3),
        "p50": round(percentile(values, 50), 3),
        "p95": round(percentile(values, 95), 3),
    }


def run_stage(
    context: multiprocessing.context.BaseContext,
    process_count: int,
    request_count: int,
    raster_path: Path,
    tile_size: int,
    index_root: Path,
) -> dict[str, Any]:
    ready = context.Queue()
    pool = context.Pool(
        processes=process_count,
        initializer=initialize_worker,
        initargs=(str(raster_path), tile_size, str(index_root), ready),
    )
    try:
        initialized_pids = {
            ready.get(timeout=300) for _ in range(process_count)
        }
        if len(initialized_pids) != process_count:
            raise RuntimeError("Not every benchmark process initialized a unique engine.")

        started_at = time.perf_counter()
        results = pool.map(calculate, range(request_count))
        duration_seconds = time.perf_counter() - started_at
    except (Exception, queue.Empty):
        pool.terminate()
        pool.join()
        raise
    else:
        pool.close()
        pool.join()
    finally:
        ready.close()
        ready.join_thread()

    populations = {round(result["population"], 6) for result in results}
    if len(populations) != 1:
        raise RuntimeError("Population results differed within a benchmark stage.")

    worker_peak_rss: dict[int, int] = {}
    for result in results:
        pid = result["pid"]
        worker_peak_rss[pid] = max(
            worker_peak_rss.get(pid, 0), result["peakRssBytes"]
        )

    cpu_seconds = sum(result["cpuSeconds"] for result in results)
    return {
        "processes": process_count,
        "requests": request_count,
        "durationSeconds": round(duration_seconds, 3),
        "rps": round(request_count / duration_seconds, 3),
        "latencyMs": timing_summary([result["latencyMs"] for result in results]),
        "classificationMs": timing_summary(
            [result["classificationMs"] for result in results]
        ),
        "extractionMs": timing_summary(
            [result["extractionMs"] for result in results]
        ),
        "workerCpuSeconds": round(cpu_seconds, 3),
        "averageCpuCores": round(cpu_seconds / duration_seconds, 3),
        "workerPeakRssMiB": round(sum(worker_peak_rss.values()) / 1024 / 1024, 1),
        "maxSingleWorkerPeakRssMiB": round(
            max(worker_peak_rss.values()) / 1024 / 1024, 1
        ),
        "workerPids": sorted(worker_peak_rss),
        "population": next(iter(populations)),
        "selectedRasterCounts": sorted(
            {result["selectedRasterCount"] for result in results}
        ),
        "rasterWorkerCounts": sorted(
            {result["rasterWorkerCount"] for result in results}
        ),
    }


def print_stage(stage: dict[str, Any]) -> None:
    print(
        " ".join(
            [
                f"processes={stage['processes']}",
                f"rps={stage['rps']}",
                f"p50={stage['latencyMs']['p50']}ms",
                f"p95={stage['latencyMs']['p95']}ms",
                f"cpu_cores={stage['averageCpuCores']}",
                f"rss={stage['workerPeakRssMiB']}MiB",
                f"classification_p50={stage['classificationMs']['p50']}ms",
                f"extraction_p50={stage['extractionMs']['p50']}ms",
            ]
        ),
        flush=True,
    )


def main() -> int:
    arguments = parse_arguments()
    context = multiprocessing.get_context("spawn")
    stages: list[dict[str, Any]] = []

    for process_count in (1, 2, 4):
        stage = run_stage(
            context,
            process_count,
            arguments.requests,
            arguments.raster_path,
            arguments.tile_size,
            arguments.index_root,
        )
        stages.append(stage)
        print_stage(stage)

    four_vs_two = stages[-1]["rps"] / stages[-2]["rps"]
    ran_eight = four_vs_two >= arguments.eight_process_threshold
    if ran_eight:
        stage = run_stage(
            context,
            8,
            arguments.requests,
            arguments.raster_path,
            arguments.tile_size,
            arguments.index_root,
        )
        stages.append(stage)
        print_stage(stage)

    baseline_rps = stages[0]["rps"]
    previous_rps: float | None = None
    for stage in stages:
        stage["scalingVsOne"] = round(stage["rps"] / baseline_rps, 3)
        stage["scalingVsPrevious"] = (
            None if previous_rps is None else round(stage["rps"] / previous_rps, 3)
        )
        previous_rps = stage["rps"]

    report = {
        "method": METHOD,
        "workload": WORKLOAD,
        "startMethod": context.get_start_method(),
        "requestsPerStage": arguments.requests,
        "eightProcessThreshold": arguments.eight_process_threshold,
        "fourVsTwoScaling": round(four_vs_two, 3),
        "ranEightProcesses": ran_eight,
        "stages": stages,
    }
    print(f"MULTIPROCESSING_BENCHMARK_JSON={json.dumps(report, separators=(',', ':'))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
