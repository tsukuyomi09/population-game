import assert from "node:assert/strict";
import test from "node:test";
import type { PopulationShape } from "../types";
import {
  calculatePopulationWithService,
  populationServiceConfigFromEnvironment,
  type PopulationServiceConfig,
} from "./population-service-client";

const shapes: PopulationShape[] = [
  {
    id: "second",
    geometry: {
      type: "Polygon",
      coordinates: [[[12, 41], [12.1, 41], [12, 41.1], [12, 41]]],
    },
  },
  {
    id: 1,
    geometry: {
      type: "Polygon",
      coordinates: [[[9, 45], [9.1, 45], [9, 45.1], [9, 45]]],
    },
  },
];

const config: PopulationServiceConfig = {
  url: "http://population.internal:8001",
  authToken: "test-token",
  timeoutMs: 1_000,
};

test("reads explicit and default service configuration", () => {
  assert.deepEqual(populationServiceConfigFromEnvironment({}), {
    url: "http://127.0.0.1:8001",
    authToken: undefined,
    timeoutMs: 120_000,
  });
  assert.deepEqual(
    populationServiceConfigFromEnvironment({
      POPULATION_SERVICE_URL: "https://population.example",
      POPULATION_SERVICE_AUTH_TOKEN: "secret",
      POPULATION_SERVICE_TIMEOUT_MS: "4500",
    }),
    {
      url: "https://population.example",
      authToken: "secret",
      timeoutMs: 4_500,
    },
  );
  assert.throws(
    () =>
      populationServiceConfigFromEnvironment({
        POPULATION_SERVICE_TIMEOUT_MS: "0",
      }),
    /must be a positive integer/,
  );
});

test("posts both calculation modes with auth and preserves ordered results", async () => {
  for (const method of ["fractional", "center"] as const) {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchImplementation: typeof fetch = async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return Response.json({
        results: [
          { id: "second", population: 10.5 },
          { id: 1, population: 20.25 },
        ],
      });
    };

    const results = await calculatePopulationWithService(
      shapes,
      method,
      config,
      fetchImplementation,
    );

    assert.equal(capturedUrl, "http://population.internal:8001/v1/calculate");
    const requestInit = capturedInit;
    assert.ok(requestInit);
    assert.equal(requestInit.method, "POST");
    assert.equal(
      new Headers(requestInit.headers).get("Authorization"),
      "Bearer test-token",
    );
    assert.equal(typeof requestInit.body, "string");
    assert.deepEqual(JSON.parse(requestInit.body as string), { method, shapes });
    assert.deepEqual(results, [
      { id: "second", population: 10.5 },
      { id: 1, population: 20.25 },
    ]);
  }
});

test("returns immediately for an empty shape batch", async () => {
  let fetchCalled = false;
  const results = await calculatePopulationWithService(
    [],
    "fractional",
    { url: "invalid", timeoutMs: 1 },
    async () => {
      fetchCalled = true;
      throw new Error("unexpected fetch");
    },
  );

  assert.deepEqual(results, []);
  assert.equal(fetchCalled, false);
});

test("rejects invalid, missing, or reordered results", async () => {
  const responseFor = (body: unknown): typeof fetch =>
    async () => Response.json(body);

  await assert.rejects(
    calculatePopulationWithService(
      shapes,
      "fractional",
      config,
      responseFor({ results: [{ id: "second", population: 1 }] }),
    ),
    /do not match the submitted shape order and IDs/,
  );
  await assert.rejects(
    calculatePopulationWithService(
      shapes,
      "fractional",
      config,
      responseFor({
        results: [
          { id: 1, population: 1 },
          { id: "second", population: 2 },
        ],
      }),
    ),
    /do not match the submitted shape order and IDs/,
  );
  await assert.rejects(
    calculatePopulationWithService(
      shapes,
      "fractional",
      config,
      responseFor({ results: [{ id: "second", population: -1 }, {}] }),
    ),
    /invalid result payload/,
  );
});

test("maps saturation into a provider error with Retry-After", async () => {
  await assert.rejects(
    calculatePopulationWithService(
      shapes,
      "center",
      config,
      async () =>
        Response.json(
          { error: "Population service is saturated." },
          { status: 503, headers: { "Retry-After": "3" } },
        ),
    ),
    /request failed \(503\): Population service is saturated\. Retry-After: 3\./,
  );
});

test("maps service, network, and timeout failures into provider errors", async () => {
  await assert.rejects(
    calculatePopulationWithService(
      shapes,
      "fractional",
      config,
      async () => Response.json({ error: "broken" }, { status: 500 }),
    ),
    /request failed \(500\): broken/,
  );

  await assert.rejects(
    calculatePopulationWithService(
      shapes,
      "fractional",
      config,
      async () => {
        throw new Error("connection refused");
      },
    ),
    /request failed: connection refused/,
  );

  await assert.rejects(
    calculatePopulationWithService(
      shapes,
      "fractional",
      { ...config, timeoutMs: 5 },
      (_url, init) =>
        new Promise((_, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    ),
    /timed out after 0.005 seconds/,
  );
});
