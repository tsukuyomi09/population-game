export const INITIAL_RANKED_MMR = 1_000;
export const MINIMUM_RANKED_MMR = 400;
export const RANKED_PLACEMENT_GAMES = 10;
export const PROVISIONAL_RANKED_MMR_K_FACTOR = 48;
export const ESTABLISHED_RANKED_MMR_K_FACTOR = 32;

export type RankedMmrOutcome = "WIN" | "LOSS" | "DRAW";

export type RankedMmrUpdate = {
  mmrBefore: number;
  mmrAfter: number;
  rankedGamesCompletedBefore: number;
  rankedGamesCompletedAfter: number;
};

function assertMmr(value: number, name: string) {
  if (!Number.isInteger(value) || value < MINIMUM_RANKED_MMR) {
    throw new Error(`${name} must be an integer at or above the MMR floor.`);
  }
}

function assertRankedGamesCompleted(value: number) {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > RANKED_PLACEMENT_GAMES
  ) {
    throw new Error("Ranked games completed must be an integer from 0 to 10.");
  }
}

function outcomeScore(outcome: RankedMmrOutcome) {
  if (outcome === "WIN") return 1;
  if (outcome === "DRAW") return 0.5;
  return 0;
}

export function rankedMmrKFactor(rankedGamesCompleted: number) {
  assertRankedGamesCompleted(rankedGamesCompleted);
  return rankedGamesCompleted < RANKED_PLACEMENT_GAMES
    ? PROVISIONAL_RANKED_MMR_K_FACTOR
    : ESTABLISHED_RANKED_MMR_K_FACTOR;
}

export function expectedRankedResult(mmr: number, opponentMmr: number) {
  assertMmr(mmr, "MMR");
  assertMmr(opponentMmr, "Opponent MMR");
  return 1 / (1 + 10 ** ((opponentMmr - mmr) / 400));
}

export function calculateRankedMmrUpdate(input: {
  mmr: number;
  opponentMmr: number;
  rankedGamesCompleted: number;
  outcome: RankedMmrOutcome;
}): RankedMmrUpdate {
  assertRankedGamesCompleted(input.rankedGamesCompleted);
  const expectedResult = expectedRankedResult(input.mmr, input.opponentMmr);
  const kFactor = rankedMmrKFactor(input.rankedGamesCompleted);
  const mmrAfter = Math.max(
    MINIMUM_RANKED_MMR,
    Math.round(
      input.mmr + kFactor * (outcomeScore(input.outcome) - expectedResult),
    ),
  );

  return {
    mmrBefore: input.mmr,
    mmrAfter,
    rankedGamesCompletedBefore: input.rankedGamesCompleted,
    rankedGamesCompletedAfter: Math.min(
      RANKED_PLACEMENT_GAMES,
      input.rankedGamesCompleted + 1,
    ),
  };
}
