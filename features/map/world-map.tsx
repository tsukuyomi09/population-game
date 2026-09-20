"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { createDraw, type DrawController } from "../drawing/draw";
import { createPolygonFeatureCollection } from "../drawing/polygons";
import {
  calculateRoundScore,
  MAX_GAME_SCORE,
  requestRoundTarget,
  ROUND_COUNT,
} from "../game/game";
import type { PopulationRequest, PopulationResponse } from "../population/types";
import {
  createMap,
  DEFAULT_MAP_PROJECTION,
  setMapProjection,
  type MapProjection,
} from "./map";

export function WorldMap() {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap>(null);
  const drawRef = useRef<DrawController>(null);
  const [isDrawReady, setIsDrawReady] = useState(false);
  const [hasStarted, setHasStarted] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [populationResponse, setPopulationResponse] =
    useState<PopulationResponse | null>(null);
  const [currentRound, setCurrentRound] = useState(0);
  const [roundScores, setRoundScores] = useState<number[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTargetLoading, setIsTargetLoading] = useState(false);
  const [projection, setProjection] = useState<MapProjection>(
    DEFAULT_MAP_PROJECTION,
  );
  const roundVersionRef = useRef(0);
  const targetRequestRef = useRef(0);
  const targetRequestPendingRef = useRef(false);

  useEffect(() => {
    if (!mapContainer.current) return;

    const map = createMap(mapContainer.current);
    mapRef.current = map;
    let drawing: DrawController | null = null;

    const initializeDrawing = () => {
      if (drawing) return;

      drawing = createDraw({
        map,
        onReady: () => setIsDrawReady(true),
      });
      drawRef.current = drawing;
    };

    map.on("style.load", initializeDrawing);

    return () => {
      map.off("style.load", initializeDrawing);
      drawing?.stop();
      drawRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  const changeProjection = (nextProjection: MapProjection) => {
    const map = mapRef.current;
    if (!map || nextProjection === projection) return;

    setMapProjection(map, nextProjection);
    drawRef.current?.setProjection(
      nextProjection === "globe" ? "globe" : "web-mercator",
    );
    setProjection(nextProjection);
  };

  const loadTarget = async () => {
    if (targetRequestPendingRef.current) return null;

    targetRequestPendingRef.current = true;
    setIsTargetLoading(true);
    const requestId = ++targetRequestRef.current;

    try {
      const nextTarget = await requestRoundTarget();
      return requestId === targetRequestRef.current ? nextTarget : null;
    } finally {
      if (requestId === targetRequestRef.current) {
        targetRequestPendingRef.current = false;
        setIsTargetLoading(false);
      }
    }
  };

  const startGame = async () => {
    try {
      const nextTarget = await loadTarget();
      if (nextTarget === null) return;

      roundVersionRef.current += 1;
      setPopulationResponse(null);
      setRoundScores([]);
      setCurrentRound(1);
      setTarget(nextTarget);
      setHasStarted(true);
    } catch (error) {
      console.error("Game start failed:", error);
    }
  };

  const abandonGame = () => {
    roundVersionRef.current += 1;
    targetRequestRef.current += 1;
    targetRequestPendingRef.current = false;
    drawRef.current?.reset();
    setIsSubmitting(false);
    setIsTargetLoading(false);
    setPopulationResponse(null);
    setRoundScores([]);
    setCurrentRound(0);
    setTarget(null);
    setHasStarted(false);
  };

  const nextRound = async () => {
    try {
      const nextTarget = await loadTarget();
      if (nextTarget === null) return;

      roundVersionRef.current += 1;
      drawRef.current?.reset();
      setIsSubmitting(false);
      setPopulationResponse(null);
      setTarget(nextTarget);
      setCurrentRound((round) => round + 1);
    } catch (error) {
      console.error("Game start failed:", error);
    }
  };

  const submitPolygons = async () => {
    if (target === null || populationResponse !== null || isSubmitting) return;

    const roundVersion = roundVersionRef.current;
    const drawings = drawRef.current?.getDrawings();
    const featureCollection = drawings
      ? createPolygonFeatureCollection(drawings)
      : { type: "FeatureCollection" as const, features: [] };

    console.log(JSON.stringify(featureCollection, null, 2));
    console.log("Completed polygons:", featureCollection.features.length);
    setIsSubmitting(true);

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

      if (roundVersion !== roundVersionRef.current) return;

      const roundScore = calculateRoundScore(
        populationResponse.totalPopulation,
        target,
      );
      setPopulationResponse(populationResponse);
      setRoundScores((scores) => [...scores, roundScore]);
      console.log("Population response:", populationResponse);
      populationResponse.results.forEach((result) => {
        console.log("Population result:", result);
      });
      console.log("Total population:", populationResponse.totalPopulation);
    } catch (error) {
      console.error("Population request failed:", error);
    } finally {
      if (roundVersion === roundVersionRef.current) setIsSubmitting(false);
    }
  };

  const accumulatedScore = roundScores.reduce((total, score) => total + score, 0);
  const currentRoundScore =
    populationResponse !== null ? (roundScores[currentRound - 1] ?? null) : null;

  return (
    <>
      <main ref={mapContainer} style={{ width: "100vw", height: "100vh" }} />
      <button
        type="button"
        onClick={submitPolygons}
        disabled={!isDrawReady || populationResponse !== null || isSubmitting}
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
          cursor:
            isDrawReady && populationResponse === null && !isSubmitting
              ? "pointer"
              : "default",
        }}
      >
        Submit
      </button>
      <div
        role="group"
        aria-label="Map projection"
        style={{
          position: "fixed",
          right: 16,
          bottom: 16,
          zIndex: 1,
          display: "flex",
          overflow: "hidden",
          border: "1px solid #777",
          borderRadius: 4,
          background: "white",
        }}
      >
        {(["mercator", "globe"] as const).map((option) => {
          const isActive = projection === option;

          return (
            <button
              key={option}
              type="button"
              onClick={() => changeProjection(option)}
              disabled={!isDrawReady}
              aria-pressed={isActive}
              style={{
                padding: "7px 10px",
                border: 0,
                background: isActive ? "#111" : "white",
                color: isActive ? "white" : "black",
                cursor: isDrawReady ? "pointer" : "default",
                fontSize: 11,
                fontWeight: 700,
              }}
            >
              {option === "mercator" ? "2D" : "GLOBE"}
            </button>
          );
        })}
      </div>
      {target !== null && (
        <>
          <div
            style={{
              position: "fixed",
              top: 16,
              left: "50%",
              zIndex: 1,
              padding: "8px 18px",
              borderRadius: 8,
              background: "rgba(0, 0, 0, 0.65)",
              color: "white",
              textAlign: "center",
              transform: "translateX(-50%)",
            }}
          >
            <div
              style={{
                marginBottom: 6,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: "0.18em",
              }}
            >
              ROUND {currentRound} / {ROUND_COUNT}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.18em" }}>
              TARGET
            </div>
            <div style={{ fontSize: 24, fontWeight: 800 }}>
              {target.toLocaleString("en-US")}
            </div>
            <div style={{ marginTop: 6, fontSize: 12 }}>
              SCORE {accumulatedScore.toLocaleString("en-US")}
            </div>
          </div>
          <button
            type="button"
            onClick={abandonGame}
            style={{
              position: "fixed",
              top: 16,
              right: 16,
              zIndex: 1,
              padding: "8px 12px",
              border: "1px solid #777",
              borderRadius: 4,
              background: "white",
              color: "black",
              cursor: "pointer",
            }}
          >
            ABANDON
          </button>
        </>
      )}
      {populationResponse !== null && currentRoundScore !== null && (
        <div
          style={{
            position: "fixed",
            bottom: 24,
            left: "50%",
            zIndex: 1,
            minWidth: 220,
            padding: "16px 24px",
            borderRadius: 8,
            background: "rgba(0, 0, 0, 0.72)",
            color: "white",
            textAlign: "center",
            transform: "translateX(-50%)",
          }}
        >
          <div style={{ fontSize: 14 }}>Hai selezionato</div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>
            {Math.round(populationResponse.totalPopulation).toLocaleString("en-US")}
          </div>
          <div style={{ marginTop: 12, fontSize: 14 }}>Round points</div>
          <div style={{ fontSize: 28, fontWeight: 800 }}>
            {currentRoundScore.toLocaleString("en-US")}
          </div>
          {currentRound < ROUND_COUNT ? (
            <button
              type="button"
              onClick={nextRound}
              disabled={isTargetLoading}
              style={{
                marginTop: 16,
                padding: "8px 16px",
                border: "1px solid white",
                borderRadius: 4,
                background: "white",
                color: "black",
                cursor: isTargetLoading ? "default" : "pointer",
                fontWeight: 700,
              }}
            >
              NEXT ROUND
            </button>
          ) : (
            <>
              <div style={{ marginTop: 12, fontSize: 14 }}>Final score</div>
              <div style={{ fontSize: 28, fontWeight: 800 }}>
                {accumulatedScore.toLocaleString("en-US")} /{" "}
                {MAX_GAME_SCORE.toLocaleString("en-US")}
              </div>
              <button
                type="button"
                onClick={abandonGame}
                style={{
                  marginTop: 16,
                  padding: "8px 16px",
                  border: "1px solid white",
                  borderRadius: 4,
                  background: "white",
                  color: "black",
                  cursor: "pointer",
                  fontWeight: 700,
                }}
              >
                END GAME
              </button>
            </>
          )}
        </div>
      )}
      {!hasStarted && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10,
            display: "grid",
            placeItems: "center",
            background: "rgba(0, 0, 0, 0.5)",
          }}
        >
          <button
            type="button"
            onClick={startGame}
            disabled={isTargetLoading}
            style={{
              padding: "18px 48px",
              border: "2px solid white",
              borderRadius: 10,
              background: "linear-gradient(180deg, #38bdf8, #0369a1)",
              boxShadow: "0 8px 24px rgba(0, 0, 0, 0.45)",
              color: "white",
              cursor: isTargetLoading ? "default" : "pointer",
              fontSize: 28,
              fontWeight: 800,
              letterSpacing: "0.18em",
              textShadow: "0 2px 4px rgba(0, 0, 0, 0.35)",
            }}
          >
            PLAY
          </button>
        </div>
      )}
    </>
  );
}
