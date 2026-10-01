import assert from "node:assert/strict";
import test from "node:test";
import {
  currentRankedRatings,
  INITIAL_RANKED_RATING,
  MINIMUM_RANKED_RATING,
  type RankedRatingsQuery,
} from "./current-ratings";

function normalizedSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

test("returns independent logical starting ratings without creating rows", async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query: RankedRatingsQuery = async (text, values) => {
    calls.push({ text: normalizedSql(text), values });
    return { rows: [] };
  };

  assert.deepEqual(await currentRankedRatings("user-1", query), {
    EASY: {
      difficulty: "EASY",
      rating: INITIAL_RANKED_RATING,
      established: false,
    },
    REAL: {
      difficulty: "REAL",
      rating: INITIAL_RANKED_RATING,
      established: false,
    },
  });
  assert.deepEqual(calls[0]?.values, ["user-1"]);
  assert.match(calls[0]?.text ?? "", /FROM competitive_ratings/);
  assert.match(calls[0]?.text ?? "", /user_id = \$1/);
  assert.match(calls[0]?.text ?? "", /difficulty IN \('EASY', 'REAL'\)/);
  assert.doesNotMatch(calls[0]?.text ?? "", /INSERT|UPDATE|DELETE/);
});

test("retrieves Easy and Real ratings independently", async () => {
  const ratings = await currentRankedRatings("user-1", async () => ({
    rows: [
      { difficulty: "EASY", rating: 1_240 },
      { difficulty: "REAL", rating: 860 },
    ],
  }));

  assert.deepEqual(ratings, {
    EASY: { difficulty: "EASY", rating: 1_240, established: true },
    REAL: { difficulty: "REAL", rating: 860, established: true },
  });
});

test("keeps a missing difficulty at its logical starting value", async () => {
  const ratings = await currentRankedRatings("user-1", async () => ({
    rows: [{ difficulty: "EASY", rating: 1_080 }],
  }));

  assert.deepEqual(ratings.EASY, {
    difficulty: "EASY",
    rating: 1_080,
    established: true,
  });
  assert.deepEqual(ratings.REAL, {
    difficulty: "REAL",
    rating: INITIAL_RANKED_RATING,
    established: false,
  });
});

test("never exposes a current rating below the minimum floor", async () => {
  const ratings = await currentRankedRatings("user-1", async () => ({
    rows: [{ difficulty: "REAL", rating: 380 }],
  }));

  assert.equal(ratings.REAL.rating, MINIMUM_RANKED_RATING);
  assert.equal(ratings.REAL.established, true);
});
