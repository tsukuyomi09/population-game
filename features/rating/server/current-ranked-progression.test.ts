import assert from "node:assert/strict";
import test from "node:test";
import {
  currentRankedProgress,
  type RankedProgressQuery,
} from "./current-ranked-progression";

function normalizedSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

test("returns independent zero-placement state without creating rows", async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query: RankedProgressQuery = async (text, values) => {
    calls.push({ text: normalizedSql(text), values });
    return { rows: [] };
  };

  assert.deepEqual(await currentRankedProgress("user-1", query), {
    EASY: {
      difficulty: "EASY",
      status: "UNRANKED",
      rankedGamesCompleted: 0,
      placementsRequired: 10,
    },
    REAL: {
      difficulty: "REAL",
      status: "UNRANKED",
      rankedGamesCompleted: 0,
      placementsRequired: 10,
    },
  });
  assert.deepEqual(calls[0]?.values, ["user-1"]);
  assert.match(calls[0]?.text ?? "", /FROM competitive_ratings/);
  assert.match(calls[0]?.text ?? "", /ranked_games_completed/);
  assert.match(calls[0]?.text ?? "", /visible_rank_score/);
  assert.doesNotMatch(calls[0]?.text ?? "", /\bmmr\b/);
  assert.doesNotMatch(calls[0]?.text ?? "", /INSERT|UPDATE|DELETE/);
});

test("returns independent Unranked and ranked states", async () => {
  const progress = await currentRankedProgress("user-1", async () => ({
    rows: [
      {
        difficulty: "EASY",
        rankedGamesCompleted: 7,
        visibleRankScore: null,
      },
      {
        difficulty: "REAL",
        rankedGamesCompleted: 10,
        visibleRankScore: 444,
      },
    ],
  }));

  assert.deepEqual(progress.EASY, {
    difficulty: "EASY",
    status: "UNRANKED",
    rankedGamesCompleted: 7,
    placementsRequired: 10,
  });
  assert.deepEqual(progress.REAL, {
    difficulty: "REAL",
    status: "RANKED",
    rankedGamesCompleted: 10,
    tier: "SILVER",
    division: "II",
    label: "Silver II",
    lp: 44,
  });
});

test("keeps a missing difficulty at zero placement progress", async () => {
  const progress = await currentRankedProgress("user-1", async () => ({
    rows: [
      {
        difficulty: "EASY",
        rankedGamesCompleted: 9,
        visibleRankScore: null,
      },
    ],
  }));

  assert.equal(progress.EASY.rankedGamesCompleted, 9);
  assert.equal(progress.REAL.rankedGamesCompleted, 0);
});
