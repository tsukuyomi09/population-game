export const ROUND_COUNT = 5;
export const MAX_ROUND_SCORE = 10_000;
export const MAX_GAME_SCORE = ROUND_COUNT * MAX_ROUND_SCORE;

export const GAME_DIFFICULTIES = ["EASY", "REAL"] as const;
export type GameDifficulty = (typeof GAME_DIFFICULTIES)[number];

export type SubmissionType = "MANUAL" | "TIMEOUT";

export function isGameDifficulty(value: unknown): value is GameDifficulty {
  return GAME_DIFFICULTIES.some((difficulty) => difficulty === value);
}

export function calculateRoundScore(totalPopulation: number, target: number) {
  const errorRatio = Math.abs(totalPopulation - target) / target;

  return Math.round(Math.max(0, MAX_ROUND_SCORE * (1 - errorRatio)));
}
