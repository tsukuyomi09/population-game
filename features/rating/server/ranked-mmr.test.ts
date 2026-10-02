import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateRankedMmrUpdate,
  ESTABLISHED_RANKED_MMR_K_FACTOR,
  expectedRankedResult,
  MINIMUM_RANKED_MMR,
  PROVISIONAL_RANKED_MMR_K_FACTOR,
  rankedMmrKFactor,
} from "./ranked-mmr";

test("equal-MMR provisional opponents move symmetrically with K48", () => {
  const winner = calculateRankedMmrUpdate({
    mmr: 1_000,
    opponentMmr: 1_000,
    rankedGamesCompleted: 0,
    outcome: "WIN",
  });
  const loser = calculateRankedMmrUpdate({
    mmr: 1_000,
    opponentMmr: 1_000,
    rankedGamesCompleted: 0,
    outcome: "LOSS",
  });

  assert.equal(expectedRankedResult(1_000, 1_000), 0.5);
  assert.equal(winner.mmrAfter, 1_024);
  assert.equal(loser.mmrAfter, 976);
});

test("favorite results move less than upsets against unequal opponents", () => {
  const favoriteWin = calculateRankedMmrUpdate({
    mmr: 1_200,
    opponentMmr: 800,
    rankedGamesCompleted: 0,
    outcome: "WIN",
  });
  const favoriteUpsetLoss = calculateRankedMmrUpdate({
    mmr: 1_200,
    opponentMmr: 800,
    rankedGamesCompleted: 0,
    outcome: "LOSS",
  });
  const underdogUpsetWin = calculateRankedMmrUpdate({
    mmr: 800,
    opponentMmr: 1_200,
    rankedGamesCompleted: 0,
    outcome: "WIN",
  });

  assert.equal(favoriteWin.mmrAfter, 1_204);
  assert.equal(favoriteUpsetLoss.mmrAfter, 1_156);
  assert.equal(underdogUpsetWin.mmrAfter, 844);
});

test("draws move unequal opponents toward each other", () => {
  const favorite = calculateRankedMmrUpdate({
    mmr: 1_200,
    opponentMmr: 800,
    rankedGamesCompleted: 0,
    outcome: "DRAW",
  });
  const underdog = calculateRankedMmrUpdate({
    mmr: 800,
    opponentMmr: 1_200,
    rankedGamesCompleted: 0,
    outcome: "DRAW",
  });

  assert.equal(favorite.mmrAfter, 1_180);
  assert.equal(underdog.mmrAfter, 820);
});

test("games 1 through 10 use K48 and game 11 uses K32", () => {
  assert.equal(rankedMmrKFactor(0), PROVISIONAL_RANKED_MMR_K_FACTOR);
  assert.equal(rankedMmrKFactor(9), PROVISIONAL_RANKED_MMR_K_FACTOR);
  assert.equal(rankedMmrKFactor(10), ESTABLISHED_RANKED_MMR_K_FACTOR);

  const tenth = calculateRankedMmrUpdate({
    mmr: 1_000,
    opponentMmr: 1_000,
    rankedGamesCompleted: 9,
    outcome: "WIN",
  });
  const eleventh = calculateRankedMmrUpdate({
    mmr: 1_000,
    opponentMmr: 1_000,
    rankedGamesCompleted: 10,
    outcome: "WIN",
  });

  assert.equal(tenth.mmrAfter, 1_024);
  assert.equal(tenth.rankedGamesCompletedAfter, 10);
  assert.equal(eleventh.mmrAfter, 1_016);
  assert.equal(eleventh.rankedGamesCompletedAfter, 10);
});

test("MMR never falls below the 400 floor", () => {
  const update = calculateRankedMmrUpdate({
    mmr: MINIMUM_RANKED_MMR,
    opponentMmr: 2_000,
    rankedGamesCompleted: 10,
    outcome: "LOSS",
  });

  assert.equal(update.mmrAfter, MINIMUM_RANKED_MMR);
});
