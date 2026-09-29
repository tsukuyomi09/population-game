import type { PopulationResponse, PopulationShape } from "../population/types";
import {
  isGameDifficulty,
  MAX_GAME_SCORE,
  MAX_ROUND_SCORE,
  ROUND_COUNT,
  type GameDifficulty,
  type SubmissionType,
} from "./single-player";
import {
  isRuntimePlayerSummary,
  type RuntimePlayerSummary,
} from "./runtime-player";

export {
  MAX_GAME_SCORE,
  MAX_ROUND_SCORE,
  ROUND_COUNT,
  type GameDifficulty,
};

export type GameRoundStart = {
  player: RuntimePlayerSummary;
  runtimeGameId: string;
  difficulty: GameDifficulty;
  roundNumber: number;
  target: number;
};

export type RoundSubmission = {
  population: PopulationResponse;
  roundScore: number;
  totalScore: number;
  submissionType: SubmissionType;
  complete: boolean;
};

async function postGameAction(path: string, body: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Game action failed (${response.status}): ${message || response.statusText}`,
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

function gameRoundStart(data: Record<string, unknown>): GameRoundStart {
  if (
    typeof data.runtimeGameId !== "string" ||
    data.runtimeGameId.length === 0 ||
    !isGameDifficulty(data.difficulty) ||
    typeof data.roundNumber !== "number" ||
    !Number.isInteger(data.roundNumber) ||
    data.roundNumber < 1 ||
    data.roundNumber > ROUND_COUNT ||
    typeof data.target !== "number" ||
    !Number.isFinite(data.target) ||
    data.target <= 0 ||
    !isRuntimePlayerSummary(data.player)
  ) {
    throw new Error("Game action returned an invalid runtime round.");
  }

  return {
    player: data.player,
    runtimeGameId: data.runtimeGameId,
    difficulty: data.difficulty,
    roundNumber: data.roundNumber,
    target: data.target,
  };
}

export async function requestGameStart(difficulty: GameDifficulty) {
  return gameRoundStart(
    await postGameAction("/api/game/start", { difficulty }),
  );
}

export async function requestNextRound(runtimeGameId: string) {
  return gameRoundStart(
    await postGameAction("/api/game/next", { runtimeGameId }),
  );
}

export async function requestRoundSubmission(
  runtimeGameId: string,
  shapes: PopulationShape[],
): Promise<RoundSubmission> {
  const data = await postGameAction("/api/game/submit", {
    runtimeGameId,
    shapes,
  });
  const population = data.population as PopulationResponse | undefined;

  if (
    !population ||
    !Array.isArray(population.results) ||
    typeof population.totalPopulation !== "number" ||
    !Number.isFinite(population.totalPopulation) ||
    typeof data.roundScore !== "number" ||
    !Number.isInteger(data.roundScore) ||
    data.roundScore < 0 ||
    data.roundScore > MAX_ROUND_SCORE ||
    typeof data.totalScore !== "number" ||
    !Number.isInteger(data.totalScore) ||
    data.totalScore < 0 ||
    data.totalScore > MAX_GAME_SCORE ||
    (data.submissionType !== "MANUAL" && data.submissionType !== "TIMEOUT") ||
    typeof data.complete !== "boolean"
  ) {
    throw new Error("Game submission returned an invalid result.");
  }

  return {
    population,
    roundScore: data.roundScore,
    totalScore: data.totalScore,
    submissionType: data.submissionType,
    complete: data.complete,
  };
}

export async function requestGameAbandon(runtimeGameId: string) {
  await postGameAction("/api/game/abandon", { runtimeGameId });
}
