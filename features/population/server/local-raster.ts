import "server-only";

import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { PopulationResult } from "../types";
import type { PopulationProvider } from "./provider";

const WORKER_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const WORKER_READY_MARKER = "__WORLDRAWING_POPULATION_WORKER_READY__";

function isPopulationResult(value: unknown): value is PopulationResult {
  if (typeof value !== "object" || value === null) return false;

  const result = value as Record<string, unknown>;
  const validId =
    (typeof result.id === "string" && result.id.length > 0) ||
    (typeof result.id === "number" && Number.isFinite(result.id));

  return (
    validId &&
    typeof result.population === "number" &&
    Number.isFinite(result.population) &&
    result.population >= 0
  );
}

export const localRasterPopulationProvider: PopulationProvider = async (
  shapes,
) => {
  if (shapes.length === 0) return [];

  const adapterStartedAt = performance.now();

  const rasterSourcePath = process.env.POPULATION_RASTER_PATH;

  if (!rasterSourcePath) {
    throw new Error("POPULATION_RASTER_PATH is required for the local raster provider.");
  }

  const pythonPath = process.env.POPULATION_PYTHON_PATH ?? "python3";
  const workerPath = path.join(process.cwd(), "tools/population/worker.py");
  const resolvedRasterSourcePath = path.resolve(rasterSourcePath);

  try {
    await access(resolvedRasterSourcePath, constants.R_OK);
  } catch {
    throw new Error(
      `Local population raster directory or file is missing or unreadable: ${resolvedRasterSourcePath}`,
    );
  }

  try {
    await access(workerPath, constants.R_OK);
  } catch {
    throw new Error(`Local population worker is missing or unreadable: ${workerPath}`);
  }

  return await new Promise((resolve, reject) => {
    const spawnStartedAt = performance.now();
    const child = spawn(
      pythonPath,
      [workerPath, "--raster", resolvedRasterSourcePath, "--method", "fractional"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    let processStartupMs: number | null = null;

    const workerDiagnostics = () =>
      stderr.replaceAll(WORKER_READY_MARKER, "").trim();

    const finish = (error?: Error, results?: PopulationResult[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(results ?? []);
    };

    const timeout = setTimeout(() => {
      child.kill();
      finish(
        new Error(
          `Local population worker timed out after ${WORKER_TIMEOUT_MS / 1_000} seconds.`,
        ),
      );
    }, WORKER_TIMEOUT_MS);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("Local population worker produced too much output."));
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (
        processStartupMs === null &&
        stderr.includes(WORKER_READY_MARKER)
      ) {
        processStartupMs = performance.now() - spawnStartedAt;
      }
      if (stderr.length > MAX_OUTPUT_BYTES) stderr = stderr.slice(-MAX_OUTPUT_BYTES);
    });
    child.on("error", (error) =>
      finish(
        new Error(
          `Could not start local population worker with ${JSON.stringify(pythonPath)}: ${error.message}`,
        ),
      ),
    );
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(
          new Error(
            `Local population worker failed (${code ?? "unknown"}): ${workerDiagnostics() || "no diagnostics"}`,
          ),
        );
        return;
      }

      try {
        if (!stdout.trim()) {
          throw new Error("Worker returned no JSON output.");
        }
        const parsed: unknown = JSON.parse(stdout);
        if (!Array.isArray(parsed) || !parsed.every(isPopulationResult)) {
          throw new Error("Worker returned an invalid result payload.");
        }
        if (
          parsed.length !== shapes.length ||
          parsed.some((result, index) => result.id !== shapes[index].id)
        ) {
          throw new Error(
            "Worker results do not match the submitted shape order and IDs.",
          );
        }

        const timingLines = [
          "[local-population timing]",
          `  submitted shapes: ${shapes.length}`,
          `  Python process startup: ${processStartupMs === null ? "unavailable" : `${processStartupMs.toFixed(1)} ms`}`,
        ];
        const diagnostics = workerDiagnostics();
        if (diagnostics) timingLines.push(diagnostics);
        timingLines.push(
          `  Next.js adapter total: ${(performance.now() - adapterStartedAt).toFixed(1)} ms`,
        );
        console.info(timingLines.join("\n"));
        finish(undefined, parsed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finish(new Error(`Could not read local population worker output: ${message}`));
      }
    });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // A fast worker failure can close stdin before Node finishes writing. Let the
      // close handler report the worker's stderr instead of replacing it with EPIPE.
      if (error.code !== "EPIPE") {
        finish(new Error(`Could not send shapes to local population worker: ${error.message}`));
      }
    });
    child.stdin.end(JSON.stringify({ shapes }));
  });
};
