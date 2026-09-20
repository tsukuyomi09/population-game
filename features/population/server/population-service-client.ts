import type { PopulationResult, PopulationShape } from "../types";
import type { PopulationCalculationMode } from "./calculation-mode";

const DEFAULT_SERVICE_URL = "http://127.0.0.1:8001";
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RESPONSE_BYTES = 1_000_000;

export type PopulationServiceConfig = {
  url: string;
  authToken?: string;
  timeoutMs: number;
};

type FetchImplementation = typeof fetch;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPopulationResult(value: unknown): value is PopulationResult {
  if (!isRecord(value)) return false;

  const validId =
    (typeof value.id === "string" && value.id.length > 0) ||
    (typeof value.id === "number" && Number.isFinite(value.id));

  return (
    validId &&
    typeof value.population === "number" &&
    Number.isFinite(value.population) &&
    value.population >= 0
  );
}

function readPositiveInteger(value: string | undefined, name: string, fallback: number) {
  if (value === undefined) return fallback;

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

export function populationServiceConfigFromEnvironment(
  environment: Record<string, string | undefined>,
): PopulationServiceConfig {
  return {
    url: environment.POPULATION_SERVICE_URL ?? DEFAULT_SERVICE_URL,
    authToken: environment.POPULATION_SERVICE_AUTH_TOKEN || undefined,
    timeoutMs: readPositiveInteger(
      environment.POPULATION_SERVICE_TIMEOUT_MS,
      "POPULATION_SERVICE_TIMEOUT_MS",
      DEFAULT_TIMEOUT_MS,
    ),
  };
}

function calculationUrl(serviceUrl: string) {
  let baseUrl: URL;
  try {
    baseUrl = new URL(serviceUrl);
  } catch {
    throw new Error("POPULATION_SERVICE_URL must be a valid URL.");
  }

  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("POPULATION_SERVICE_URL must use HTTP or HTTPS.");
  }

  return new URL("/v1/calculate", baseUrl).toString();
}

async function readResponseBody(response: Response): Promise<unknown> {
  const responseText = await response.text();
  if (responseText.length > MAX_RESPONSE_BYTES) {
    throw new Error("Population service returned too much output.");
  }
  if (!responseText) return null;

  try {
    return JSON.parse(responseText);
  } catch {
    return responseText;
  }
}

function serviceErrorMessage(body: unknown) {
  if (isRecord(body) && typeof body.error === "string" && body.error.length > 0) {
    return body.error;
  }
  if (typeof body === "string" && body.length > 0) return body;
  return null;
}

export async function calculatePopulationWithService(
  shapes: PopulationShape[],
  calculationMode: PopulationCalculationMode,
  config: PopulationServiceConfig,
  fetchImplementation: FetchImplementation = fetch,
): Promise<PopulationResult[]> {
  if (shapes.length === 0) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const timeoutError = () =>
    new Error(
      `Population service timed out after ${config.timeoutMs / 1_000} seconds.`,
    );

  try {
    let response: Response;
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.authToken) {
        headers.Authorization = `Bearer ${config.authToken}`;
      }

      response = await fetchImplementation(calculationUrl(config.url), {
        method: "POST",
        headers,
        body: JSON.stringify({ method: calculationMode, shapes }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Population service request failed: ${message}`);
    }

    let body: unknown;
    try {
      body = await readResponseBody(response);
    } catch (error) {
      if (controller.signal.aborted) throw timeoutError();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not read population service response: ${message}`);
    }

    if (!response.ok) {
      const detail = serviceErrorMessage(body);
      const retryAfter = response.headers.get("Retry-After");
      const retryMessage = retryAfter ? ` Retry-After: ${retryAfter}.` : "";
      throw new Error(
        `Population service request failed (${response.status})${detail ? `: ${detail}` : "."}${retryMessage}`,
      );
    }

    const results = isRecord(body) ? body.results : undefined;
    if (!Array.isArray(results) || !results.every(isPopulationResult)) {
      throw new Error("Population service returned an invalid result payload.");
    }
    if (
      results.length !== shapes.length ||
      results.some((result, index) => result.id !== shapes[index].id)
    ) {
      throw new Error(
        "Population service results do not match the submitted shape order and IDs.",
      );
    }

    return results;
  } finally {
    clearTimeout(timeout);
  }
}
