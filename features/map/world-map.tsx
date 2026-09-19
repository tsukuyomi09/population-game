"use client";

import { useEffect, useRef, useState } from "react";
import type { MapMouseEvent } from "maplibre-gl";
import { createDraw, type DrawController } from "../drawing/draw";
import { createPolygonFeatureCollection } from "../drawing/polygons";
import type { PopulationRequest, PopulationResponse } from "../population/types";
import { createMap } from "./map";

export function WorldMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const drawRef = useRef<DrawController>(null);
  const [isDrawReady, setIsDrawReady] = useState(false);
  const [isDrawing, setIsDrawing] = useState(false);

  useEffect(() => {
    if (!mapContainer.current) return;

    const map = createMap(mapContainer.current);
    let drawing: DrawController | null = null;

    const preventMapNavigationWhileDrawing = (event: MapMouseEvent) => {
      if (drawing?.isDrawingPolygon()) event.preventDefault();
    };

    const initializeDrawing = () => {
      drawing = createDraw({
        map,
        onReady: () => setIsDrawReady(true),
        onFinish: () => setIsDrawing(false),
      });
      drawRef.current = drawing;
    };

    map.on("mousedown", preventMapNavigationWhileDrawing);
    map.on("style.load", initializeDrawing);

    return () => {
      map.off("mousedown", preventMapNavigationWhileDrawing);
      map.off("style.load", initializeDrawing);
      drawing?.stop();
      drawRef.current = null;
      map.remove();
    };
  }, []);

  const startDrawing = () => {
    drawRef.current?.startPolygonDrawing();
    setIsDrawing(true);
  };

  const submitPolygons = async () => {
    const draw = drawRef.current?.draw;
    const featureCollection = draw
      ? createPolygonFeatureCollection(draw)
      : { type: "FeatureCollection" as const, features: [] };

    console.log(JSON.stringify(featureCollection, null, 2));
    console.log("Completed polygons:", featureCollection.features.length);

    try {
      const requestBody: PopulationRequest = {
        shapes: featureCollection.features.map((feature) => {
          if (feature.id === undefined) {
            throw new Error("A completed polygon is missing an id.");
          }

          return {
            id: feature.id,
            geometry: feature.geometry,
          };
        }),
      };

      const response = await fetch("/api/population", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const message = await response.text();
        throw new Error(
          `Population request failed (${response.status}): ${message || response.statusText}`,
        );
      }

      const populationResponse = (await response.json()) as PopulationResponse;

      console.log("Population response:", populationResponse);
      populationResponse.results.forEach((result) => {
        console.log("Population result:", result);
      });
      console.log("Total population:", populationResponse.totalPopulation);
    } catch (error) {
      console.error("Population request failed:", error);
    }
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
