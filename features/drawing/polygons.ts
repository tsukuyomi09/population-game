import type { TerraDraw } from "terra-draw";

export function createPolygonFeatureCollection(draw: TerraDraw) {
  const polygons = draw.getSnapshot().filter(
    (feature) =>
      feature.geometry.type === "Polygon" &&
      feature.properties.currentlyDrawing !== true,
  );

  return {
    type: "FeatureCollection" as const,
    features: polygons,
  };
}
