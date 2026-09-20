import { Map } from "maplibre-gl";

export type MapProjection = "mercator" | "globe";

export const DEFAULT_MAP_PROJECTION: MapProjection = "globe";

export function createMap(container: HTMLElement) {
  const map = new Map({
    container,
    center: [137.9150899566626, 36.25956997955441],
    zoom: 0,
    style: "https://tiles.openfreemap.org/styles/liberty",
  });

  map.on("style.load", () =>
    map.setProjection({ type: DEFAULT_MAP_PROJECTION }),
  );

  return map;
}

export function setMapProjection(map: Map, projection: MapProjection) {
  map.setProjection({ type: projection });
}
