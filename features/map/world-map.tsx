"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ChevronRight,
  Layers3,
  RotateCcw,
  Target,
  Trophy,
} from "lucide-react";
import {
  GoogleDrawingMapAdapter,
  type GoogleMap,
  type GoogleMapsEventListener,
  type GoogleMapsNamespace,
  type GoogleRenderingType,
} from "./google-drawing-map-adapter";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { createDraw, type DrawController } from "../drawing/draw";
import { createPolygonFeatureCollection } from "../drawing/polygons";
import {
  type GameDifficulty,
  MAX_GAME_SCORE,
  MAX_ROUND_SCORE,
  requestGameAbandon,
  requestGameStart,
  requestNextRound,
  requestRoundSubmission,
  ROUND_COUNT,
} from "../game/game";
import type { RuntimePlayerSummary } from "../game/runtime-player";
import type { PopulationRequest, PopulationResponse } from "../population/types";
import { createGoogleWorldMap, loadGoogleMaps } from "./google-map";

const RESULT_BADGE_THRESHOLDS = [
  {
    minimumScore: MAX_ROUND_SCORE,
    label: "PERFECT",
    className: "border-primary/40 bg-primary/15 text-primary",
  },
  {
    minimumScore: 9_500,
    label: "NAILED IT",
    className: "border-emerald-300/35 bg-emerald-300/12 text-emerald-200",
  },
  {
    minimumScore: 8_500,
    label: "SO CLOSE",
    className: "border-sky-300/35 bg-sky-300/12 text-sky-200",
  },
  {
    minimumScore: 6_500,
    label: "NICE",
    className: "border-violet-300/35 bg-violet-300/12 text-violet-200",
  },
] as const;

const integerFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

function AnimatedNumber({ value, className }: { value: number; className?: string }) {
  const previousValueRef = useRef(0);
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const from = previousValueRef.current;
    previousValueRef.current = value;

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplayValue(value);
      return;
    }

    const startedAt = performance.now();
    const duration = 650;
    let animationFrame = 0;

    const update = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplayValue(Math.round(from + (value - from) * eased));

      if (progress < 1) animationFrame = requestAnimationFrame(update);
    };

    animationFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrame);
  }, [value]);

  return <span className={className}>{integerFormatter.format(displayValue)}</span>;
}

function resultBadge(score: number, difference: number) {
  const scoreBadge = RESULT_BADGE_THRESHOLDS.find(
    ({ minimumScore }) => score >= minimumScore,
  );
  if (scoreBadge) return scoreBadge;

  if (difference > 0) {
    return {
      label: "WAY OVER",
      className: "border-amber-300/35 bg-amber-300/12 text-amber-200",
    };
  }
  if (difference < 0) {
    return {
      label: "WAY UNDER",
      className: "border-orange-300/35 bg-orange-300/12 text-orange-200",
    };
  }

  return {
    label: "OUCH",
    className: "border-red-300/35 bg-red-300/12 text-red-200",
  };
}

function ScoreProgress({ scores }: { scores: number[] }) {
  return (
    <ol className="grid grid-cols-5 gap-2" aria-label="Round scores">
      {Array.from({ length: ROUND_COUNT }, (_, index) => {
        const score = scores[index];

        return (
          <li key={index} className="min-w-0 text-center">
            <span className="text-[0.6rem] font-bold tracking-wider text-muted-foreground">
              R{index + 1}
            </span>
            <div
              className={cn(
                "mt-1 rounded-md border px-1 py-2 font-mono text-xs font-black",
                score === undefined
                  ? "border-border bg-background/35 text-muted-foreground"
                  : score === MAX_ROUND_SCORE
                    ? "border-primary/35 bg-primary/10 text-primary"
                    : "border-border bg-background/65 text-foreground",
              )}
            >
              {score === undefined ? "—" : integerFormatter.format(score)}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function WorldMap({
  initialDifficulty,
}: {
  initialDifficulty?: GameDifficulty;
}) {
  const router = useRouter();
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<GoogleMap>(null);
  const drawRef = useRef<DrawController>(null);
  const mapCreationCountRef = useRef(0);
  const [isDrawReady, setIsDrawReady] = useState(false);
  const [mapCreationCount, setMapCreationCount] = useState(0);
  const [renderingType, setRenderingType] =
    useState<GoogleRenderingType>("UNINITIALIZED");
  const [mapError, setMapError] = useState<string | null>(null);
  const [runtimePlayer, setRuntimePlayer] =
    useState<RuntimePlayerSummary | null>(null);
  const [runtimeGameId, setRuntimeGameId] = useState<string | null>(null);
  const [difficulty, setDifficulty] = useState<GameDifficulty>(
    initialDifficulty ?? "EASY",
  );
  const [target, setTarget] = useState<number | null>(null);
  const [populationResponse, setPopulationResponse] =
    useState<PopulationResponse | null>(null);
  const [currentRound, setCurrentRound] = useState(0);
  const [roundScores, setRoundScores] = useState<number[]>([]);
  const [totalScore, setTotalScore] = useState(0);
  const [completedDrawingCount, setCompletedDrawingCount] = useState(0);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isTargetLoading, setIsTargetLoading] = useState(false);
  const roundVersionRef = useRef(0);
  const targetRequestRef = useRef(0);
  const targetRequestPendingRef = useRef(false);
  const autoStartAttemptedRef = useRef(false);
  const [isAutoStarting, setIsAutoStarting] = useState(
    initialDifficulty !== undefined,
  );
  const apiKey = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY;

  useEffect(() => {
    const container = mapContainer.current;
    if (!container) return;

    if (!apiKey) {
      setMapError("Missing NEXT_PUBLIC_GOOGLE_MAPS_API_KEY");
      return;
    }

    let cancelled = false;
    let map: GoogleMap | null = null;
    let maps: GoogleMapsNamespace | null = null;
    let adapter: GoogleDrawingMapAdapter | null = null;
    let drawing: DrawController | null = null;
    let tilesLoadedListener: GoogleMapsEventListener | null = null;

    loadGoogleMaps(apiKey)
      .then((loadedMaps) => {
        if (cancelled) return;

        maps = loadedMaps;
        map = createGoogleWorldMap(container, loadedMaps);
        mapRef.current = map;
        mapCreationCountRef.current += 1;
        setMapCreationCount(mapCreationCountRef.current);
        setRenderingType(map.getRenderingType());

        tilesLoadedListener = loadedMaps.event.addListenerOnce(
          map,
          "tilesloaded",
          () => {
            if (!map || cancelled) return;
            setRenderingType(map.getRenderingType());
          },
        );

        adapter = new GoogleDrawingMapAdapter({
          container,
          map,
          maps: loadedMaps,
          onCompletedDrawingCountChange: setCompletedDrawingCount,
          onModeChange: () => undefined,
        });

        return adapter.whenReady().then(() => {
          if (cancelled || !adapter) return;
          drawing = createDraw({
            map: adapter.asMapLibreMap(),
            onReady: () => setIsDrawReady(true),
          });
          drawRef.current = drawing;
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setMapError(
          error instanceof Error ? error.message : "Google Maps failed to load.",
        );
      });

    return () => {
      cancelled = true;
      tilesLoadedListener?.remove();
      drawing?.stop();
      adapter?.stop();
      if (map && maps) maps.event.clearInstanceListeners(map);
      drawRef.current = null;
      mapRef.current = null;
      container.replaceChildren();
    };
  }, [apiKey]);

  const loadRound = async (
    requestRound: () => ReturnType<typeof requestGameStart>,
  ) => {
    if (targetRequestPendingRef.current) return null;

    targetRequestPendingRef.current = true;
    setIsTargetLoading(true);
    const requestId = ++targetRequestRef.current;

    try {
      const nextRound = await requestRound();
      return requestId === targetRequestRef.current ? nextRound : null;
    } finally {
      if (requestId === targetRequestRef.current) {
        targetRequestPendingRef.current = false;
        setIsTargetLoading(false);
      }
    }
  };

  const startGame = async (selectedDifficulty = difficulty) => {
    try {
      const nextRound = await loadRound(() =>
        requestGameStart(selectedDifficulty),
      );
      if (nextRound === null) return;

      roundVersionRef.current += 1;
      setPopulationResponse(null);
      setRoundScores([]);
      setTotalScore(0);
      setCurrentRound(nextRound.roundNumber);
      setTarget(nextRound.target);
      setRuntimePlayer(nextRound.player);
      setRuntimeGameId(nextRound.runtimeGameId);
      setDifficulty(nextRound.difficulty);
    } catch (error) {
      console.error("Game start failed:", error);
    }
  };

  useEffect(() => {
    if (!initialDifficulty || autoStartAttemptedRef.current) return;

    autoStartAttemptedRef.current = true;
    void startGame(initialDifficulty).finally(() => setIsAutoStarting(false));
  }, [initialDifficulty]);

  const resetGame = () => {
    roundVersionRef.current += 1;
    targetRequestRef.current += 1;
    targetRequestPendingRef.current = false;
    drawRef.current?.reset();
    setIsSubmitting(false);
    setIsTargetLoading(false);
    setPopulationResponse(null);
    setRoundScores([]);
    setTotalScore(0);
    setCompletedDrawingCount(0);
    setCurrentRound(0);
    setTarget(null);
    setRuntimePlayer(null);
    setRuntimeGameId(null);
  };

  const abandonGame = async () => {
    if (runtimeGameId === null) return;

    const destination =
      runtimePlayer?.kind === "registered" ? "/profile" : "/";

    try {
      await requestGameAbandon(runtimeGameId);
      resetGame();
      router.push(destination);
    } catch (error) {
      console.error("Game abandon failed:", error);
    }
  };

  const nextRound = async () => {
    if (runtimeGameId === null) return;

    try {
      const nextRound = await loadRound(() => requestNextRound(runtimeGameId));
      if (nextRound === null || runtimePlayer === null) return;

      if (
        nextRound.runtimeGameId !== runtimeGameId ||
        nextRound.player.runtimePlayerId !== runtimePlayer.runtimePlayerId
      ) {
        throw new Error("Game session identity changed during an active game.");
      }

      roundVersionRef.current += 1;
      drawRef.current?.reset();
      setCompletedDrawingCount(0);
      setIsSubmitting(false);
      setPopulationResponse(null);
      setTarget(nextRound.target);
      setCurrentRound(nextRound.roundNumber);
    } catch (error) {
      console.error("Game start failed:", error);
    }
  };

  const playAgain = async () => {
    setIsAutoStarting(true);
    resetGame();

    try {
      await startGame(difficulty);
    } finally {
      setIsAutoStarting(false);
    }
  };

  const submitPolygons = async () => {
    if (
      target === null ||
      runtimeGameId === null ||
      populationResponse !== null ||
      isSubmitting
    ) {
      return;
    }

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

      const submission = await requestRoundSubmission(
        runtimeGameId,
        requestBody.shapes,
      );

      if (roundVersion !== roundVersionRef.current) return;

      const populationResponse = submission.population;
      const roundScore = submission.roundScore;
      setPopulationResponse(populationResponse);
      setRoundScores((scores) => [...scores, roundScore]);
      setTotalScore(submission.totalScore);
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

  const accumulatedScore = totalScore;
  const currentRoundScore =
    populationResponse !== null ? (roundScores[currentRound - 1] ?? null) : null;
  const calculatedPopulation =
    populationResponse === null
      ? null
      : Math.round(populationResponse.totalPopulation);
  const difference =
    calculatedPopulation === null || target === null
      ? null
      : calculatedPopulation - target;
  const percentageError =
    difference === null || target === null
      ? null
      : (Math.abs(difference) / target) * 100;
  const badge =
    currentRoundScore === null || difference === null
      ? null
      : resultBadge(currentRoundScore, difference);
  const isFinalResult =
    populationResponse !== null &&
    currentRoundScore !== null &&
    currentRound === ROUND_COUNT;
  const bestRound = roundScores.length > 0 ? Math.max(...roundScores) : 0;
  const averageRound =
    roundScores.length > 0
      ? Math.round(
          roundScores.reduce((total, score) => total + score, 0) /
            roundScores.length,
        )
      : 0;
  const perfectRounds = roundScores.filter(
    (score) => score === MAX_ROUND_SCORE,
  ).length;
  const zeroRounds = roundScores.filter((score) => score === 0).length;

  return (
    <>
      <main ref={mapContainer} className="h-screen w-screen" />
      <div className="dark contents">
        {mapError !== null && (
          <div className="fixed inset-x-3 top-3 z-50 rounded-lg border border-red-300/20 bg-red-950/95 px-4 py-3 text-center text-sm text-red-100 shadow-xl">
            {mapError}
          </div>
        )}
        {process.env.NODE_ENV === "development" && (
          <aside className="pointer-events-none fixed right-3 bottom-3 z-10 rounded-md bg-black/75 px-3 py-2 font-mono text-[0.65rem] text-white shadow">
            <div>Google rendering: {renderingType}</div>
            <div>Map creations: {mapCreationCount}</div>
          </aside>
        )}

        {runtimePlayer !== null &&
          target !== null &&
          populationResponse === null && (
            <>
              <section className="fixed top-3 left-3 z-20 w-[calc(100vw-7.5rem)] max-w-[25rem] rounded-xl border border-white/10 bg-background/90 px-4 py-3 text-foreground shadow-xl backdrop-blur-md sm:left-1/2 sm:w-full sm:-translate-x-1/2">
                <div className="flex items-center justify-between gap-3 text-[0.65rem] font-black tracking-[0.16em] uppercase">
                  <span
                    className={
                      difficulty === "EASY" ? "text-primary" : "text-sky-300"
                    }
                  >
                    {difficulty}
                  </span>
                  <span className="text-muted-foreground">
                    Round {currentRound}/{ROUND_COUNT}
                  </span>
                </div>
                <div className="mt-2 flex items-end justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-1.5 text-[0.62rem] font-bold tracking-[0.16em] text-muted-foreground uppercase">
                      <Target className="size-3" aria-hidden="true" />
                      Target population
                    </div>
                    <div className="mt-0.5 font-mono text-2xl font-black tracking-tight sm:text-3xl">
                      {integerFormatter.format(target)}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[0.62rem] font-bold tracking-[0.14em] text-muted-foreground uppercase">
                      Total
                    </div>
                    <AnimatedNumber
                      value={accumulatedScore}
                      className="font-mono text-base font-black"
                    />
                  </div>
                </div>
              </section>

              <Button
                type="button"
                onClick={abandonGame}
                variant="ghost"
                size="sm"
                className="fixed top-3 right-3 z-20 border border-white/10 bg-background/80 text-xs text-muted-foreground shadow-lg backdrop-blur-md hover:bg-background hover:text-foreground"
              >
                Abandon
              </Button>

              <div className="fixed bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-white/10 bg-background/90 p-2 pl-3 text-foreground shadow-2xl backdrop-blur-md">
                <div className="flex items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
                  <Layers3 className="size-4" aria-hidden="true" />
                  {completedDrawingCount === 1
                    ? "1 area"
                    : `${completedDrawingCount} areas`}
                </div>
                <Button
                  type="button"
                  onClick={submitPolygons}
                  disabled={!isDrawReady || isSubmitting}
                  className="h-10 px-5 font-black"
                >
                  {isSubmitting ? "Submitting…" : "Submit"}
                  {!isSubmitting && <ChevronRight aria-hidden="true" />}
                </Button>
              </div>
            </>
          )}

        {populationResponse !== null &&
          currentRoundScore !== null &&
          target !== null &&
          calculatedPopulation !== null &&
          difference !== null &&
          percentageError !== null &&
          badge !== null &&
          !isFinalResult && (
            <section className="animate-in fade-in slide-in-from-bottom-4 fixed inset-x-3 bottom-3 z-30 max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-2xl border border-white/10 bg-background/95 p-5 text-foreground shadow-2xl backdrop-blur-md duration-300 sm:inset-x-auto sm:top-3 sm:right-3 sm:bottom-auto sm:w-[25rem] sm:p-6">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-[0.65rem] font-black tracking-[0.17em] text-muted-foreground uppercase">
                    {difficulty} · Round {currentRound}/{ROUND_COUNT}
                  </p>
                  <span
                    className={cn(
                      "mt-2 inline-flex rounded-full border px-2.5 py-1 text-[0.68rem] font-black tracking-[0.14em]",
                      badge.className,
                    )}
                  >
                    {badge.label}
                  </span>
                </div>
                <Trophy className="size-7 text-primary" aria-hidden="true" />
              </div>

              <dl className="mt-6 grid grid-cols-2 gap-x-5 gap-y-4">
                <div>
                  <dt className="text-[0.62rem] font-bold tracking-wider text-muted-foreground uppercase">
                    Target
                  </dt>
                  <dd className="mt-1 font-mono text-lg font-black">
                    {integerFormatter.format(target)}
                  </dd>
                </div>
                <div className="text-right">
                  <dt className="text-[0.62rem] font-bold tracking-wider text-muted-foreground uppercase">
                    Your population
                  </dt>
                  <dd className="mt-1 font-mono text-lg font-black">
                    {integerFormatter.format(calculatedPopulation)}
                  </dd>
                </div>
                <div className="col-span-2 flex items-center justify-between border-t border-border pt-4 text-sm">
                  <dt className="text-muted-foreground">
                    {difference === 0
                      ? "Exactly on target"
                      : difference > 0
                        ? "Over target"
                        : "Under target"}
                  </dt>
                  <dd className="font-mono font-black">
                    {difference === 0 ? "—" : integerFormatter.format(Math.abs(difference))}
                    <span className="ml-2 text-muted-foreground">
                      ({percentageError < 10
                        ? percentageError.toFixed(1)
                        : Math.round(percentageError)}
                      %)
                    </span>
                  </dd>
                </div>
              </dl>

              <div className="mt-5 grid grid-cols-2 gap-3 rounded-xl border border-border bg-card p-4">
                <div>
                  <p className="text-[0.62rem] font-bold tracking-wider text-muted-foreground uppercase">
                    Round score
                  </p>
                  <AnimatedNumber
                    value={currentRoundScore}
                    className="mt-1 block font-mono text-3xl font-black text-primary"
                  />
                </div>
                <div className="border-l border-border pl-4">
                  <p className="text-[0.62rem] font-bold tracking-wider text-muted-foreground uppercase">
                    Total score
                  </p>
                  <AnimatedNumber
                    value={accumulatedScore}
                    className="mt-1 block font-mono text-3xl font-black"
                  />
                </div>
              </div>

              <div className="mt-5">
                <ScoreProgress scores={roundScores} />
              </div>

              <Button
                type="button"
                onClick={nextRound}
                disabled={isTargetLoading}
                className="mt-6 h-11 w-full font-black"
              >
                {isTargetLoading ? "Loading…" : "Next round"}
                {!isTargetLoading && <ChevronRight aria-hidden="true" />}
              </Button>
              <Button
                type="button"
                onClick={abandonGame}
                variant="ghost"
                size="sm"
                className="mt-2 w-full text-muted-foreground"
              >
                Abandon game
              </Button>
            </section>
          )}

        {isFinalResult && (
          <div className="animate-in fade-in fixed inset-0 z-30 grid place-items-center overflow-y-auto bg-black/45 p-3 text-foreground backdrop-blur-[2px] duration-300">
            <section className="animate-in zoom-in-95 my-auto w-full max-w-xl rounded-2xl border border-white/10 bg-background/96 p-5 shadow-2xl duration-300 sm:p-7">
              <div className="text-center">
                <p className="text-xs font-black tracking-[0.2em] text-primary uppercase">
                  {difficulty} · Run complete
                </p>
                <h1 className="mt-3 text-3xl font-black tracking-tight">
                  Final score
                </h1>
                <div className="mt-2 font-mono text-5xl font-black tracking-tight sm:text-6xl">
                  <AnimatedNumber value={accumulatedScore} />
                </div>
                <p className="mt-1 font-mono text-sm text-muted-foreground">
                  out of {integerFormatter.format(MAX_GAME_SCORE)}
                </p>
              </div>

              <div className="mt-7">
                <ScoreProgress scores={roundScores} />
              </div>

              <dl className="mt-6 grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-4">
                {[
                  ["Best round", integerFormatter.format(bestRound)],
                  ["Average", integerFormatter.format(averageRound)],
                  ["Perfect", String(perfectRounds)],
                  ["Zero", String(zeroRounds)],
                ].map(([label, value]) => (
                  <div key={label} className="bg-card px-3 py-4 text-center">
                    <dt className="text-[0.6rem] font-bold tracking-wider text-muted-foreground uppercase">
                      {label}
                    </dt>
                    <dd className="mt-1 font-mono text-lg font-black">{value}</dd>
                  </div>
                ))}
              </dl>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <Button
                  type="button"
                  onClick={playAgain}
                  disabled={isTargetLoading}
                  className="h-11 font-black"
                >
                  <RotateCcw aria-hidden="true" />
                  Play again
                </Button>
                <Button asChild variant="outline" className="h-11 font-bold">
                  <Link href="/">
                    <ArrowLeft aria-hidden="true" />
                    Back home
                  </Link>
                </Button>
              </div>
            </section>
          </div>
        )}

        {runtimePlayer === null && isAutoStarting && (
          <div className="fixed inset-0 z-40 grid place-items-center bg-black/45">
            <div className="rounded-lg border border-white/10 bg-background/90 px-5 py-3 text-sm font-bold text-foreground shadow-xl backdrop-blur-md">
              Starting {difficulty === "EASY" ? "Easy" : "Real"}…
            </div>
          </div>
        )}
        {runtimePlayer === null && !isAutoStarting && (
          <div className="fixed inset-0 z-40 grid place-items-center bg-black/50 p-4 backdrop-blur-[2px]">
            <section className="w-full max-w-sm rounded-2xl border border-white/10 bg-background/95 p-6 text-center text-foreground shadow-2xl">
              <p className="text-xs font-black tracking-[0.18em] text-primary uppercase">
                Single Player
              </p>
              <h1 className="mt-2 text-3xl font-black">Choose difficulty</h1>
              <div
                role="group"
                aria-label="Game difficulty"
                className="mt-6 grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-card"
              >
                {(["EASY", "REAL"] as const).map((option) => (
                  <Button
                    key={option}
                    type="button"
                    onClick={() => setDifficulty(option)}
                    aria-pressed={difficulty === option}
                    variant="ghost"
                    className={cn(
                      "h-11 rounded-none font-black",
                      difficulty === option
                        ? "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {option}
                  </Button>
                ))}
              </div>
              <Button
                type="button"
                onClick={() => startGame()}
                disabled={isTargetLoading}
                className="mt-4 h-12 w-full text-base font-black"
              >
                {isTargetLoading ? "Starting…" : "Play"}
                {!isTargetLoading && <ChevronRight aria-hidden="true" />}
              </Button>
              <Button asChild variant="ghost" size="sm" className="mt-2">
                <Link href="/">Back home</Link>
              </Button>
            </section>
          </div>
        )}
      </div>
    </>
  );
}
