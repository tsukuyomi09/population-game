export const ROUND_COUNT = 5;
export const MAX_ROUND_SCORE = 10_000;
export const MAX_GAME_SCORE = ROUND_COUNT * MAX_ROUND_SCORE;

export function calculateRoundScore(totalPopulation: number, target: number) {
  const errorRatio = Math.abs(totalPopulation - target) / target;

  return Math.round(Math.max(0, MAX_ROUND_SCORE * (1 - errorRatio)));
}

export async function requestRoundTarget() {
  const response = await fetch("/api/game/start", { method: "POST" });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(
      `Game start failed (${response.status}): ${message || response.statusText}`,
    );
  }

  const data = (await response.json()) as { target: number };

  if (typeof data.target !== "number" || !Number.isFinite(data.target)) {
    throw new Error("Game start returned an invalid target.");
  }

  return data.target;
}
