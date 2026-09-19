import type {
  PopulationRequest,
  PopulationResponse,
  PopulationShape,
} from "../../../features/population/types";
import { calculateWorldPopPopulation } from "../../../features/population/server/worldpop";

function isPopulationShape(value: unknown): value is PopulationShape {
  if (typeof value !== "object" || value === null) return false;

  const shape = value as Record<string, unknown>;
  const hasValidId =
    (typeof shape.id === "string" && shape.id.length > 0) ||
    (typeof shape.id === "number" && Number.isFinite(shape.id));

  if (!hasValidId || typeof shape.geometry !== "object" || shape.geometry === null) {
    return false;
  }

  const geometry = shape.geometry as Record<string, unknown>;
  return geometry.type === "Polygon" && Array.isArray(geometry.coordinates);
}

export async function POST(request: Request) {
  let body: unknown;

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Malformed JSON." }, { status: 400 });
  }

  if (
    typeof body !== "object" ||
    body === null ||
    !Array.isArray((body as Record<string, unknown>).shapes)
  ) {
    return Response.json({ error: "A shapes array is required." }, { status: 400 });
  }

  const { shapes } = body as PopulationRequest;

  if (!shapes.every(isPopulationShape)) {
    return Response.json(
      { error: "Every shape must have an id and Polygon geometry." },
      { status: 400 },
    );
  }

  try {
    const results = [];

    for (const shape of shapes) {
      const population = await calculateWorldPopPopulation(shape.geometry);
      results.push({ id: shape.id, population });
    }

    const response: PopulationResponse = {
      results,
      totalPopulation: results.reduce((total, result) => total + result.population, 0),
    };

    return Response.json(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown WorldPop error.";
    console.error("Population calculation failed:", error);

    return Response.json({ error: message }, { status: 502 });
  }
}
