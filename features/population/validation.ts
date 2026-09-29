import type { PopulationShape } from "./types";

export function isPopulationShape(value: unknown): value is PopulationShape {
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
