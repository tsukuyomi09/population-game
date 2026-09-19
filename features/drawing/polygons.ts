import type { TerraDraw } from "terra-draw";
import type { Polygon } from "geojson";

type DrawFeature = ReturnType<TerraDraw["getSnapshot"]>[number];
type DrawPolygonFeature = DrawFeature & { geometry: Polygon };

export function createPolygonFeatureCollection(draw: TerraDraw) {
  const polygons = draw.getSnapshot().filter(
    (feature): feature is DrawPolygonFeature =>
      feature.geometry.type === "Polygon" &&
      feature.properties.currentlyDrawing !== true,
  );

  return {
    type: "FeatureCollection" as const,
    features: polygons,
  };
}
