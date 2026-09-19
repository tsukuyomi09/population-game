import { Map } from "maplibre-gl";

export function createMap(container: HTMLElement) {
  return new Map({
    container,
    center: [137.9150899566626, 36.25956997955441],
    zoom: 0,
    style: {
      version: 8,
      projection: {
        type: "globe",
      },
      sources: {
        satellite: {
          type: "raster",
          tiles: [
            "https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg",
          ],
        },
      },
      layers: [
        {
          id: "satellite",
          type: "raster",
          source: "satellite",
        },
      ],
      sky: {
        "atmosphere-blend": ["interpolate", ["linear"], ["zoom"], 0, 1, 5, 1, 7, 0],
      },
      light: {
        anchor: "map",
        position: [1.5, 90, 80],
      },
    },
  });
}
