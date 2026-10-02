import assert from "node:assert/strict";
import test from "node:test";
import {
  expectedMmrFromVisibleRankScore,
  rankedProgress,
  visibleLpChange,
  visibleRankScoreAfterMatch,
  visibleRankScoreFromMmr,
} from "./ranked-visible-progression";

const bands = [
  [400, 599, "Bronze III"],
  [600, 749, "Bronze II"],
  [750, 849, "Bronze I"],
  [850, 949, "Silver III"],
  [950, 1_049, "Silver II"],
  [1_050, 1_149, "Silver I"],
  [1_150, 1_249, "Gold III"],
  [1_250, 1_349, "Gold II"],
  [1_350, 1_449, "Gold I"],
  [1_450, 1_574, "Platinum III"],
  [1_575, 1_699, "Platinum II"],
  [1_700, 1_824, "Platinum I"],
  [1_825, 1_949, "Diamond III"],
  [1_950, 2_074, "Diamond II"],
  [2_075, 2_199, "Diamond I"],
] as const;

function placed(visibleRankScore: number) {
  const progress = rankedProgress(10, visibleRankScore);
  if (progress.status !== "RANKED") throw new Error("Expected ranked progress.");
  return progress;
}

test("every normal MMR band reveals at 0 LP and ends at 99 LP", () => {
  for (const [lower, upper, label] of bands) {
    const lowerProgress = placed(visibleRankScoreFromMmr(lower));
    const upperProgress = placed(visibleRankScoreFromMmr(upper));
    assert.equal(lowerProgress.label, label);
    assert.equal(lowerProgress.lp, 0);
    assert.equal(upperProgress.label, label);
    assert.equal(upperProgress.lp, 99);
  }
});

test("placement reveal uses proportional LP and open-ended Master LP", () => {
  assert.deepEqual(rankedProgress(10, visibleRankScoreFromMmr(994)), {
    status: "RANKED",
    rankedGamesCompleted: 10,
    tier: "SILVER",
    division: "II",
    label: "Silver II",
    lp: 44,
  });
  assert.equal(placed(visibleRankScoreFromMmr(2_200)).lp, 0);
  assert.equal(placed(visibleRankScoreFromMmr(2_300)).lp, 100);
});

test("players remain Unranked through game 9", () => {
  assert.deepEqual(rankedProgress(9, null), {
    status: "UNRANKED",
    rankedGamesCompleted: 9,
    placementsRequired: 10,
  });
  assert.throws(() => rankedProgress(9, 400));
  assert.throws(() => rankedProgress(10, null));
});

test("expected visible MMR interpolates each band and Master", () => {
  assert.equal(expectedMmrFromVisibleRankScore(850), 1_400);
  assert.equal(expectedMmrFromVisibleRankScore(1_450), 2_137.5);
  assert.equal(expectedMmrFromVisibleRankScore(1_600), 2_300);
});

test("alignment bands select the approved win and loss values", () => {
  const visibleRankScoreBefore = 750;
  const change = (mmrBefore: number, outcome: "WIN" | "LOSS") =>
    visibleLpChange({ mmrBefore, visibleRankScoreBefore, outcome });

  assert.equal(change(1_400, "WIN"), 16);
  assert.equal(change(1_200, "LOSS"), -16);
  assert.equal(change(1_401, "WIN"), 18);
  assert.equal(change(1_401, "LOSS"), -14);
  assert.equal(change(1_501, "WIN"), 20);
  assert.equal(change(1_501, "LOSS"), -12);
  assert.equal(change(1_199, "WIN"), 14);
  assert.equal(change(1_199, "LOSS"), -18);
  assert.equal(change(1_099, "WIN"), 12);
  assert.equal(change(1_099, "LOSS"), -20);
  assert.equal(
    visibleLpChange({
      mmrBefore: 1_700,
      visibleRankScoreBefore,
      outcome: "DRAW",
    }),
    0,
  );
});

test("LP overflow and underflow promote and demote naturally", () => {
  const promoted = visibleRankScoreAfterMatch({
    mmrBefore: 1_344,
    visibleRankScoreBefore: 794,
    outcome: "WIN",
  });
  const demoted = visibleRankScoreAfterMatch({
    mmrBefore: 1_258,
    visibleRankScoreBefore: 708,
    outcome: "LOSS",
  });

  assert.equal(placed(promoted).label, "Gold I");
  assert.equal(placed(promoted).lp, 10);
  assert.equal(placed(demoted).label, "Gold III");
  assert.equal(placed(demoted).lp, 92);
});

test("Master promotes, demotes, and remains open-ended", () => {
  const promoted = visibleRankScoreAfterMatch({
    mmrBefore: 2_192,
    visibleRankScoreBefore: 1_494,
    outcome: "WIN",
  });
  const demoted = visibleRankScoreAfterMatch({
    mmrBefore: 2_208,
    visibleRankScoreBefore: 1_508,
    outcome: "LOSS",
  });

  assert.equal(placed(promoted).label, "Master");
  assert.equal(placed(promoted).lp, 10);
  assert.equal(placed(demoted).label, "Diamond I");
  assert.equal(placed(demoted).lp, 92);
  assert.equal(placed(1_750).lp, 250);
});

test("the bottom of Bronze III is the visible progression floor", () => {
  assert.equal(
    visibleRankScoreAfterMatch({
      mmrBefore: 400,
      visibleRankScoreBefore: 0,
      outcome: "LOSS",
    }),
    0,
  );
});
