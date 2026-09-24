import process from "node:process";
import { performance } from "node:perf_hooks";

const DEFAULT_STAGES = [10, 25, 50, 100];
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAUSE_MS = 2_000;

const payload = {
  targetPopulation: 1_000_000,
  shapes: [
    {
      id: "railway-load-test",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [12.35, 41.8],
            [12.65, 41.8],
            [12.65, 42.02],
            [12.35, 42.02],
            [12.35, 41.8],
          ],
        ],
      },
    },
  ],
};

function readArguments(values) {
  const options = {
    url: process.env.POPULATION_LOAD_TEST_URL,
    stages: DEFAULT_STAGES,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pauseMs: DEFAULT_PAUSE_MS,
  };

  for (let index = 0; index < values.length; index += 1) {
    const argument = values[index];
    const value = values[index + 1];
    if (argument === "--url") options.url = value;
    else if (argument === "--stages") {
      options.stages = value?.split(",").map(Number);
    } else if (argument === "--timeout-ms") options.timeoutMs = Number(value);
    else if (argument === "--pause-ms") options.pauseMs = Number(value);
    else throw new Error(`Unknown argument: ${argument}`);
    index += 1;
  }

  if (!options.url) {
    throw new Error(
      "Set POPULATION_LOAD_TEST_URL or pass --url with the deployed web URL.",
    );
  }
  if (
    !Array.isArray(options.stages) ||
    options.stages.length === 0 ||
    options.stages.some(
      (value) => !Number.isSafeInteger(value) || value <= 0 || value > 100,
    )
  ) {
    throw new Error("Stages must be comma-separated integers between 1 and 100.");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error("Timeout must be a positive integer.");
  }
  if (!Number.isSafeInteger(options.pauseMs) || options.pauseMs < 0) {
    throw new Error("Pause must be a non-negative integer.");
  }

  const endpoint = new URL("/api/population", options.url);
  if (endpoint.protocol !== "http:" && endpoint.protocol !== "https:") {
    throw new Error("Load-test URL must use HTTP or HTTPS.");
  }
  options.url = endpoint.toString();
  return options;
}

function percentile(sortedValues, percentileValue) {
  if (sortedValues.length === 0) return null;
  const index = Math.ceil((percentileValue / 100) * sortedValues.length) - 1;
  return Math.round(sortedValues[Math.max(0, index)]);
}

function summarizeLatencies(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

async function sendRequest(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await response.text();
    const latencyMs = performance.now() - startedAt;
    const saturation =
      response.status === 503 ||
      /population service request failed \(503\)|service is saturated/i.test(body);

    let validSuccess = false;
    if (response.ok) {
      try {
        const parsed = JSON.parse(body);
        validSuccess =
          Array.isArray(parsed.results) &&
          parsed.results.length === 1 &&
          parsed.results[0]?.id === payload.shapes[0].id &&
          Number.isFinite(parsed.results[0]?.population) &&
          Number.isFinite(parsed.totalPopulation);
      } catch {
        validSuccess = false;
      }
    }

    return {
      latencyMs,
      status: response.status,
      success: response.ok && validSuccess,
      saturation,
      timeout: false,
    };
  } catch (error) {
    return {
      latencyMs: performance.now() - startedAt,
      status: null,
      success: false,
      saturation: false,
      timeout: controller.signal.aborted,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runStage(url, concurrency, timeoutMs) {
  const startedAt = performance.now();
  const results = await Promise.all(
    Array.from({ length: concurrency }, () => sendRequest(url, timeoutMs)),
  );
  const durationSeconds = (performance.now() - startedAt) / 1_000;
  const successes = results.filter((result) => result.success);
  const timeouts = results.filter((result) => result.timeout).length;
  const saturation = results.filter((result) => result.saturation).length;
  const http503 = results.filter((result) => result.status === 503).length;
  const statuses = {};

  for (const result of results) {
    const key = result.status === null ? "network" : String(result.status);
    statuses[key] = (statuses[key] ?? 0) + 1;
  }

  return {
    concurrency,
    requests: results.length,
    durationSeconds: Number(durationSeconds.toFixed(3)),
    requestsPerSecond: Number((results.length / durationSeconds).toFixed(2)),
    successfulRequestsPerSecond: Number(
      (successes.length / durationSeconds).toFixed(2),
    ),
    success: successes.length,
    errors: results.length - successes.length,
    successRatePercent: Number(
      ((successes.length / results.length) * 100).toFixed(2),
    ),
    saturation,
    http503,
    timeouts,
    statuses,
    latencyMs: summarizeLatencies(results.map((result) => result.latencyMs)),
    successfulLatencyMs: summarizeLatencies(
      successes.map((result) => result.latencyMs),
    ),
  };
}

function stageIsHealthy(stage) {
  return stage.errors === 0 && stage.saturation === 0 && stage.timeouts === 0;
}

function printStage(stage) {
  const latency = stage.successfulLatencyMs;
  console.log(
    [
      `concurrency=${stage.concurrency}`,
      `requests=${stage.requests}`,
      `rps=${stage.requestsPerSecond}`,
      `success=${stage.success}/${stage.requests}`,
      `p50=${latency.p50 ?? "-"}ms`,
      `p95=${latency.p95 ?? "-"}ms`,
      `p99=${latency.p99 ?? "-"}ms`,
      `http503=${stage.http503}`,
      `saturation=${stage.saturation}`,
      `timeouts=${stage.timeouts}`,
      `statuses=${JSON.stringify(stage.statuses)}`,
    ].join(" "),
  );
}

let options;
try {
  options = readArguments(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}

const report = {
  endpoint: options.url,
  startedAt: new Date().toISOString(),
  payload,
  stages: [],
};

for (const concurrency of options.stages) {
  const stage = await runStage(options.url, concurrency, options.timeoutMs);
  report.stages.push(stage);
  printStage(stage);

  if (!stageIsHealthy(stage)) {
    console.log(`Stopping after concurrency ${concurrency}: stage was not healthy.`);
    break;
  }
  if (concurrency !== options.stages.at(-1) && options.pauseMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
  }
}

report.finishedAt = new Date().toISOString();
console.log(`LOAD_TEST_JSON=${JSON.stringify(report)}`);
