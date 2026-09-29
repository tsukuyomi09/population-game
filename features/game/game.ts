import {
  isRuntimePlayerSummary,
  type RuntimePlayerSummary,
} from "./runtime-player";

export const ROUND_COUNT = 5;
export const MAX_ROUND_SCORE = 10_000;
export const MAX_GAME_SCORE = ROUND_COUNT * MAX_ROUND_SCORE;

export type GameRoundStart = {
  player: RuntimePlayerSummary;
  target: number;
};

export function calculateRoundScore(totalPopulation: number, target: number) {
  const errorRatio = Math.abs(totalPopulation - target) / target;

  return Math.round(Math.max(0, MAX_ROUND_SCORE * (1 - errorRatio)));
}

export async function requestRoundStart(): Promise<GameRoundStart> {
  const response = await fetch("/api/game/start", { method: "POST" });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Game start failed (${response.status}): ${message || response.statusText}`,
    );
  }

  const data = (await response.json()) as Record<string, unknown>;

  if (
    typeof data.target !== "number" ||
    !Number.isFinite(data.target) ||
    !isRuntimePlayerSummary(data.player)
  ) {
    throw new Error("Game start returned an invalid runtime session.");
  }

  return { player: data.player, target: data.target };
}
