"use client";

import { useEffect, useRef, useState } from "react";
import { Map, type MapMouseEvent } from "maplibre-gl";
import { TerraDraw, TerraDrawPolygonMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";

export default function Home() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const drawRef = useRef<TerraDraw>(null);
  const [isDrawReady, setIsDrawReady] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);

  useEffect(() => {
    if (!mapContainer.current) return;

    const map = new Map({
      container: mapContainer.current,
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

    let draw: TerraDraw | null = null;

    const finishDrawing = () => {
      draw?.setMode("static");
      setIsDrawing(false);
    };

    const preventMapNavigationWhileDrawing = (event: MapMouseEvent) => {
      if (draw?.getMode() === "polygon") event.preventDefault();
    };

    const initializeDrawing = () => {
      draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map, minPixelDragDistance: 8 }),
        modes: [new TerraDrawPolygonMode({ projection: "globe" })],
      });

      draw.on("ready", () => setIsDrawReady(true));
      draw.on("finish", finishDrawing);
      draw.start();
      drawRef.current = draw;
    };

    map.on("mousedown", preventMapNavigationWhileDrawing);
    map.on("style.load", initializeDrawing);

    return () => {
      map.off("mousedown", preventMapNavigationWhileDrawing);
      map.off("style.load", initializeDrawing);
      draw?.off("finish", finishDrawing);
      draw?.stop();
      drawRef.current = null;
      map.remove();
    };
  }, []);

  const startDrawing = () => {
    drawRef.current?.setMode("polygon");
    setIsDrawing(true);
  };

  const submitPolygons = () => {
    const polygons =
      drawRef.current?.getSnapshot().filter(
        (feature) =>
          feature.geometry.type === "Polygon" &&
          feature.properties.currentlyDrawing !== true,
      ) ?? [];

    const featureCollection = {
      type: "FeatureCollection" as const,
      features: polygons,
    };

    console.log(JSON.stringify(featureCollection, null, 2));
    console.log("Completed polygons:", polygons.length);
  };

  return (
    <>
      <main ref={mapContainer} style={{ width: "100vw", height: "100vh" }} />
      <button
        type="button"
        onClick={startDrawing}
        disabled={!isDrawReady || isDrawing}
        aria-pressed={isDrawing}
        style={{
          position: "fixed",
          top: 16,
          left: 16,
          zIndex: 1,
          padding: "8px 12px",
          border: "1px solid #777",
          borderRadius: 4,
          background: "white",
          color: "black",
          cursor: isDrawReady && !isDrawing ? "pointer" : "default",
        }}
      >
        {isDrawing ? "Drawing…" : "Draw"}
      </button>
      <button
        type="button"
        onClick={submitPolygons}
        disabled={!isDrawReady}
        style={{
          position: "fixed",
          top: 16,
          left: 88,
          zIndex: 1,
          padding: "8px 12px",
          border: "1px solid #777",
          borderRadius: 4,
          background: "white",
          color: "black",
          cursor: isDrawReady ? "pointer" : "default",
        }}
      >
        Submit
      </button>
    </>
  );
}
