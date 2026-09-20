import type { FeatureCollection, Polygon } from "geojson";
import type { CompletedDrawing } from "./draw";

export function createPolygonFeatureCollection(
  drawings: CompletedDrawing[],
): FeatureCollection<Polygon> {
  return {
    type: "FeatureCollection",
    features: drawings
      .filter((drawing) => drawing.closed)
      .map((drawing) => ({
        id: drawing.id,
        type: "Feature",
        properties: {},
        geometry: {
          type: "Polygon",
          coordinates: [drawing.points],
        },
      })),
  };
}
