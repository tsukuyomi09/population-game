import assert from "node:assert/strict";
import test from "node:test";
import {
  rankedLeaderboard,
  type RankedLeaderboardQuery,
} from "./ranked-leaderboard";

function normalizedSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

test("returns one current-rating entry per player for the requested difficulty", async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query: RankedLeaderboardQuery = async (text, values) => {
    calls.push({ text, values });
    return {
      rows: [
        { username: "atlas", avatarId: "cat", rating: 1_220 },
        { username: "meridian", avatarId: "dog", rating: 1_180 },
      ],
    };
  };

  const entries = await rankedLeaderboard("REAL", query);
  const sql = normalizedSql(calls[0].text);

  assert.deepEqual(calls[0].values, ["REAL"]);
  assert.deepEqual(entries, [
    { rank: 1, username: "atlas", avatarId: "cat", rating: 1_220 },
    { rank: 2, username: "meridian", avatarId: "dog", rating: 1_180 },
  ]);
  assert.match(sql, /FROM competitive_ratings JOIN users/);
  assert.match(sql, /competitive_ratings\.difficulty = \$1/);
  assert.match(sql, /competitive_ratings\.rating DESC/);
  assert.match(sql, /LIMIT 10/);
  assert.doesNotMatch(sql, /FROM games/);
  assert.doesNotMatch(sql, /game_players/);
});

test("caps Ranked standings at ten players", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    username: `player-${index + 1}`,
    avatarId: "cat",
    rating: 1_500 - index * 20,
  }));
  const query: RankedLeaderboardQuery = async () => ({ rows });

  const entries = await rankedLeaderboard("EASY", query);

  assert.equal(entries.length, 10);
  assert.deepEqual(
    entries.map(({ rank, rating }) => ({ rank, rating })),
    rows.slice(0, 10).map(({ rating }, index) => ({
      rank: index + 1,
      rating,
    })),
  );
});
