"use client";

import { useEffect, useRef, useState } from "react";
import type { Map as MapLibreMap } from "maplibre-gl";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
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
      <main ref={mapContainer} className="h-screen w-screen" />
      <Button
        type="button"
        onClick={submitPolygons}
        disabled={!isDrawReady || populationResponse !== null || isSubmitting}
        variant="outline"
        className="fixed top-4 left-4 z-[1] h-auto cursor-pointer rounded-[4px] border-[#777] bg-white px-3 py-2 text-[13.3333px] font-normal text-black shadow-none hover:bg-white disabled:pointer-events-auto disabled:cursor-default disabled:opacity-100"
      >
        Submit
      </Button>
      <div
        role="group"
        aria-label="Map projection"
        className="fixed right-4 bottom-4 z-[1] flex overflow-hidden rounded-[4px] border border-[#777] bg-white"
      >
        {(["mercator", "globe"] as const).map((option) => {
          const isActive = projection === option;

          return (
            <Button
              key={option}
              type="button"
              onClick={() => changeProjection(option)}
              disabled={!isDrawReady}
              aria-pressed={isActive}
              variant="ghost"
              className={cn(
                "h-auto cursor-pointer rounded-none border-0 px-[10px] py-[7px] text-[11px] font-bold shadow-none disabled:pointer-events-auto disabled:cursor-default disabled:opacity-100",
                isActive
                  ? "bg-[#111] text-white hover:bg-[#111] hover:text-white"
                  : "bg-white text-black hover:bg-white hover:text-black",
              )}
            >
              {option === "mercator" ? "2D" : "GLOBE"}
            </Button>
          );
        })}
      </div>
      {target !== null && (
        <>
          <div className="fixed top-4 left-1/2 z-[1] -translate-x-1/2 rounded-[8px] bg-black/[0.65] px-[18px] py-2 text-center text-white">
            <div className="mb-1.5 text-[11px] font-bold tracking-[0.18em]">
              ROUND {currentRound} / {ROUND_COUNT}
            </div>
            <div className="text-[11px] font-bold tracking-[0.18em]">
              TARGET
            </div>
            <div className="text-2xl font-extrabold">
              {target.toLocaleString("en-US")}
            </div>
            <div className="mt-1.5 text-xs">
              SCORE {accumulatedScore.toLocaleString("en-US")}
            </div>
          </div>
          <Button
            type="button"
            onClick={abandonGame}
            variant="outline"
            className="fixed top-4 right-4 z-[1] h-auto cursor-pointer rounded-[4px] border-[#777] bg-white px-3 py-2 text-[13.3333px] font-normal text-black shadow-none hover:bg-white"
          >
            ABANDON
          </Button>
        </>
      )}
      {populationResponse !== null && currentRoundScore !== null && (
        <div className="fixed bottom-6 left-1/2 z-[1] min-w-[220px] -translate-x-1/2 rounded-[8px] bg-black/[0.72] px-6 py-4 text-center text-white">
          <div className="text-sm">Hai selezionato</div>
          <div className="text-[28px] font-extrabold">
            {Math.round(populationResponse.totalPopulation).toLocaleString("en-US")}
          </div>
          <div className="mt-3 text-sm">Round points</div>
          <div className="text-[28px] font-extrabold">
            {currentRoundScore.toLocaleString("en-US")}
          </div>
          {currentRound < ROUND_COUNT ? (
            <Button
              type="button"
              onClick={nextRound}
              disabled={isTargetLoading}
              variant="outline"
              className="mt-4 h-auto cursor-pointer rounded-[4px] border-white bg-white px-4 py-2 font-bold text-black shadow-none hover:bg-white disabled:pointer-events-auto disabled:cursor-default disabled:opacity-100"
            >
              NEXT ROUND
            </Button>
          ) : (
            <>
              <div className="mt-3 text-sm">Final score</div>
              <div className="text-[28px] font-extrabold">
                {accumulatedScore.toLocaleString("en-US")} /{" "}
                {MAX_GAME_SCORE.toLocaleString("en-US")}
              </div>
              <Button
                type="button"
                onClick={abandonGame}
                variant="outline"
                className="mt-4 h-auto cursor-pointer rounded-[4px] border-white bg-white px-4 py-2 font-bold text-black shadow-none hover:bg-white"
              >
                END GAME
              </Button>
            </>
          )}
        </div>
      )}
      {!hasStarted && (
        <div className="fixed inset-0 z-10 grid place-items-center bg-black/50">
          <Button
            type="button"
            onClick={startGame}
            disabled={isTargetLoading}
            className="h-auto cursor-pointer rounded-[10px] border-2 border-white bg-[linear-gradient(180deg,#38bdf8,#0369a1)] px-12 py-[18px] text-[28px] font-extrabold tracking-[0.18em] text-white [text-shadow:0_2px_4px_rgba(0,0,0,0.35)] shadow-[0_8px_24px_rgba(0,0,0,0.45)] hover:bg-[linear-gradient(180deg,#38bdf8,#0369a1)] disabled:pointer-events-auto disabled:cursor-default disabled:opacity-100"
          >
            PLAY
          </Button>
        </div>
      )}
    </>
  );
}
