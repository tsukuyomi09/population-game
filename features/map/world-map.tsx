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
} from "lucide-react";
import {
  GoogleDrawingMapAdapter,
  type GoogleMap,
  type GoogleMapsNamespace,
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

function scoreRevealTone(score: number) {
  if (score === MAX_ROUND_SCORE) {
    return {
      score: "text-yellow-100 drop-shadow-[0_0_16px_rgba(254,240,138,0.55)]",
      track: "bg-black/80 ring-2 ring-yellow-200/50",
      bar: "bg-gradient-to-r from-emerald-400 via-lime-300 to-yellow-100 shadow-[0_0_22px_rgba(190,242,100,0.9)]",
    };
  }
  if (score >= 9_500) {
    return {
      score: "text-emerald-100",
      track: "bg-black/80",
      bar: "bg-emerald-400 shadow-[0_0_18px_rgba(52,211,153,0.7)]",
    };
  }
  if (score >= 8_500) {
    return {
      score: "text-sky-100",
      track: "bg-black/80",
      bar: "bg-sky-400 shadow-[0_0_18px_rgba(56,189,248,0.65)]",
    };
  }
  if (score >= 6_500) {
    return {
      score: "text-violet-100",
      track: "bg-black/80",
      bar: "bg-violet-400 shadow-[0_0_18px_rgba(167,139,250,0.65)]",
    };
  }
  if (score > 0) {
    return {
      score: "text-amber-100",
      track: "bg-black/80",
      bar: "bg-amber-400 shadow-[0_0_18px_rgba(251,191,36,0.6)]",
    };
  }
  return {
    score: "text-red-100",
    track: "bg-black/80",
    bar: "bg-red-400",
  };
}

function ScoreReveal({ score }: { score: number }) {
  const finalRatio = Math.min(1, Math.max(0, score / MAX_ROUND_SCORE));
  const [reveal, setReveal] = useState({ score: 0, ratio: 0 });
  const tone = scoreRevealTone(score);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setReveal({ score, ratio: finalRatio });
      return;
    }

    setReveal({ score: 0, ratio: 0 });
    let startedAt: number | null = null;
    let animationFrame = 0;
    const duration = 2_400;

    const update = (now: number) => {
      startedAt ??= now;
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 4);

      setReveal({
        score: progress === 1 ? score : Math.round(score * eased),
        ratio: progress === 1 ? finalRatio : finalRatio * eased,
      });

      if (progress < 1) animationFrame = requestAnimationFrame(update);
    };

    animationFrame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(animationFrame);
  }, [finalRatio, score]);

  return (
    <div className="w-full">
      <div className="flex items-baseline justify-center gap-2">
        <span
          className={cn(
            "font-mono text-5xl leading-none font-black tracking-tight sm:text-6xl",
            tone.score,
          )}
        >
          {integerFormatter.format(reveal.score)}
        </span>
        <span className="font-mono text-xs font-bold text-white/55">
          / {integerFormatter.format(MAX_ROUND_SCORE)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Round score"
        aria-valuemin={0}
        aria-valuemax={MAX_ROUND_SCORE}
        aria-valuenow={reveal.score}
        className={cn(
          "mt-4 h-[1.125rem] overflow-hidden rounded-full border border-white/15 shadow-inner",
          tone.track,
        )}
      >
        <div
          className={cn(
            "h-full origin-left rounded-full will-change-transform",
            tone.bar,
          )}
          style={{ transform: `scaleX(${reveal.ratio})` }}
        />
      </div>
    </div>
  );
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

function ScoreProgress({
  scores,
  compact = false,
}: {
  scores: number[];
  compact?: boolean;
}) {
  if (compact) {
    return (
      <ol className="grid grid-cols-5 gap-2" aria-label="Round scores">
        {Array.from({ length: ROUND_COUNT }, (_, index) => {
          const score = scores[index];
          const ratio = score === undefined ? 0 : score / MAX_ROUND_SCORE;

          return (
            <li key={index} className="min-w-0 text-center">
              <div className="h-1 overflow-hidden rounded-full bg-black/65">
                <div
                  className={cn(
                    "h-full rounded-full",
                    score === MAX_ROUND_SCORE ? "bg-yellow-200" : "bg-primary/75",
                  )}
                  style={{ width: `${ratio * 100}%` }}
                />
              </div>
              <span className="mt-1 block text-[0.5rem] font-bold tracking-wider text-white/65">
                R{index + 1}
              </span>
              <span className="block truncate font-mono text-[0.6rem] font-black text-white/95">
                {score === undefined ? "—" : integerFormatter.format(score)}
              </span>
            </li>
          );
        })}
      </ol>
    );
  }

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
  const [isDrawReady, setIsDrawReady] = useState(false);
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

    loadGoogleMaps(apiKey)
      .then((loadedMaps) => {
        if (cancelled) return;

        maps = loadedMaps;
        map = createGoogleWorldMap(container, loadedMaps);
        mapRef.current = map;

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
        {runtimePlayer !== null &&
          target !== null &&
          populationResponse === null && (
            <>
              <div className="fixed top-3 left-3 z-20 flex items-center gap-2 rounded-full border border-white/10 bg-background/90 px-3 py-2 text-[0.65rem] font-black tracking-[0.14em] text-foreground uppercase shadow-lg backdrop-blur-md">
                <span
                  className={
                    difficulty === "EASY" ? "text-primary" : "text-sky-300"
                  }
                >
                  {difficulty}
                </span>
                <span className="size-1 rounded-full bg-white/25" />
                <span className="text-muted-foreground">
                  R{currentRound}/{ROUND_COUNT}
                </span>
              </div>

              <section className="fixed top-14 left-1/2 z-20 -translate-x-1/2 rounded-xl border border-primary/20 bg-background/92 px-4 py-2 text-center text-foreground shadow-xl backdrop-blur-md md:top-3">
                <div className="flex items-center justify-center gap-1.5 text-[0.56rem] font-black tracking-[0.16em] text-primary uppercase">
                  <Target className="size-3" aria-hidden="true" />
                  Target
                </div>
                <div className="font-mono text-2xl leading-none font-black tracking-tight">
                  {integerFormatter.format(target)}
                </div>
              </section>

              <div className="fixed top-3 right-3 z-20 flex items-center gap-2">
                <div className="rounded-full border border-sky-300/20 bg-background/90 px-3 py-1.5 text-right text-foreground shadow-lg backdrop-blur-md">
                  <div className="text-[0.5rem] font-black tracking-[0.14em] text-sky-300 uppercase">
                    Total
                  </div>
                  <AnimatedNumber
                    value={accumulatedScore}
                    className="block font-mono text-sm leading-none font-black"
                  />
                </div>
                <Button
                  type="button"
                  onClick={abandonGame}
                  variant="ghost"
                  size="sm"
                  className="border border-white/10 bg-background/75 text-xs text-muted-foreground shadow-lg backdrop-blur-md hover:bg-background hover:text-foreground"
                >
                  Abandon
                </Button>
              </div>

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
          badge !== null &&
          !isFinalResult && (
            <div className="animate-in fade-in fixed inset-0 z-30 grid place-items-center overflow-y-auto bg-black/35 p-4 text-foreground duration-300">
              <section className="animate-in zoom-in-95 my-auto w-full max-w-lg px-2 py-5 text-center duration-300 sm:px-5">
                <span
                  className={cn(
                    "inline-flex rounded-full border px-3 py-1 text-[0.68rem] font-black tracking-[0.16em]",
                    badge.className,
                  )}
                >
                  {badge.label}
                </span>

                <div className="mt-5">
                  <ScoreReveal score={currentRoundScore} />
                </div>

                <p className="mt-5 inline-flex max-w-full items-center justify-center gap-2 rounded-full bg-black/60 px-3 py-1.5 font-mono text-xs shadow-lg backdrop-blur-sm sm:text-sm">
                  <span className="text-white/75">You</span>
                  <span className="truncate font-black text-white">
                    {integerFormatter.format(calculatedPopulation)}
                  </span>
                  <span className="text-white/55">vs</span>
                  <span className="text-white/75">Target</span>
                  <span className="truncate font-black text-white">
                    {integerFormatter.format(target)}
                  </span>
                </p>

                <div className="mx-auto mt-5 max-w-sm">
                  <ScoreProgress scores={roundScores} compact />
                </div>

                <Button
                  type="button"
                  onClick={nextRound}
                  disabled={isTargetLoading}
                  className="mt-6 h-11 w-full max-w-56 font-black shadow-xl"
                >
                  {isTargetLoading ? "Loading…" : "Next round"}
                  {!isTargetLoading && <ChevronRight aria-hidden="true" />}
                </Button>
              </section>
            </div>
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
