import "server-only";

import type { Polygon } from "geojson";
import type { PopulationResult, PopulationShape } from "../types";

const POPULATION_URL = "https://api.worldpop.org/v2/population";
const TASKS_URL = "https://api.worldpop.org/v2/tasks";
const POLL_INTERVAL_MS = 1_000;
const TIMEOUT_MS = 60_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describe(value: unknown) {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function fetchBeforeDeadline(
  url: string,
  deadline: number,
  init?: RequestInit,
) {
  const remainingMs = deadline - Date.now();

  if (remainingMs <= 0) {
    throw new Error(`WorldPop calculation timed out after ${TIMEOUT_MS / 1_000} seconds.`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`WorldPop calculation timed out after ${TIMEOUT_MS / 1_000} seconds.`);
    }

    const message = error instanceof Error ? error.message : describe(error);
    throw new Error(`WorldPop request failed: ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function calculateWorldPopPolygonPopulation(geometry: Polygon) {
  const deadline = Date.now() + TIMEOUT_MS;
  const submission = await fetchBeforeDeadline(POPULATION_URL, deadline, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      geojson: geometry,
      year: 2026,
      resolution: "100m",
    }),
  });
  const submissionBody = await readBody(submission);

  if (!submission.ok) {
    throw new Error(
      `WorldPop rejected the population request (${submission.status}): ${describe(submissionBody)}`,
    );
  }

  if (!isRecord(submissionBody) || typeof submissionBody.task_id !== "string") {
    throw new Error(`WorldPop returned no task id: ${describe(submissionBody)}`);
  }

  const taskUrl = `${TASKS_URL}/${encodeURIComponent(submissionBody.task_id)}`;

  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remainingMs)),
    );

    const taskResponse = await fetchBeforeDeadline(taskUrl, deadline);
    const taskBody = await readBody(taskResponse);

    if (!taskResponse.ok) {
      throw new Error(
        `WorldPop task polling failed (${taskResponse.status}): ${describe(taskBody)}`,
      );
    }

    if (!isRecord(taskBody) || typeof taskBody.status !== "string") {
      throw new Error(`WorldPop returned an invalid task response: ${describe(taskBody)}`);
    }

    if (taskBody.status === "success") {
      const result = taskBody.result;
      const population = isRecord(result) ? result.total_population : undefined;

      if (typeof population !== "number" || !Number.isFinite(population)) {
        throw new Error(`WorldPop returned an invalid population result: ${describe(taskBody)}`);
      }

      return population;
    }

    if (taskBody.status === "failure" || taskBody.status === "failed") {
      throw new Error(
        `WorldPop population calculation failed: ${describe(taskBody.error ?? taskBody)}`,
      );
    }
  }

  throw new Error(`WorldPop calculation timed out after ${TIMEOUT_MS / 1_000} seconds.`);
}

export async function worldPopPopulationProvider(
  shapes: PopulationShape[],
): Promise<PopulationResult[]> {
  const results: PopulationResult[] = [];

  // Preserve the existing sequential request behavior while exposing a batch boundary.
  for (const shape of shapes) {
    const population = await calculateWorldPopPolygonPopulation(shape.geometry);
    results.push({ id: shape.id, population });
  }

  return results;
}
