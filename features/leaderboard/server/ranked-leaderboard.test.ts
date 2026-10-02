import assert from "node:assert/strict";
import test from "node:test";
import {
  rankedLeaderboard,
  type RankedLeaderboardQuery,
} from "./ranked-leaderboard";

function normalizedSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

test("returns visible rank and LP for placed players only", async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query: RankedLeaderboardQuery = async (text, values) => {
    calls.push({ text, values });
    return {
      rows: [
        { username: "atlas", avatarId: "cat", visibleRankScore: 1_612 },
        { username: "meridian", avatarId: "dog", visibleRankScore: 1_450 },
      ],
    };
  };

  const entries = await rankedLeaderboard("REAL", query);
  const sql = normalizedSql(calls[0].text);

  assert.deepEqual(calls[0].values, ["REAL"]);
  assert.deepEqual(entries, [
    {
      rank: 1,
      username: "atlas",
      avatarId: "cat",
      tier: "MASTER",
      division: null,
      label: "Master",
      lp: 112,
    },
    {
      rank: 2,
      username: "meridian",
      avatarId: "dog",
      tier: "DIAMOND",
      division: "I",
      label: "Diamond I",
      lp: 50,
    },
  ]);
  assert.match(sql, /FROM competitive_ratings JOIN users/);
  assert.match(sql, /competitive_ratings\.difficulty = \$1/);
  assert.match(sql, /competitive_ratings\.visible_rank_score AS "visibleRankScore"/);
  assert.match(sql, /competitive_ratings\.ranked_games_completed = 10/);
  assert.match(sql, /competitive_ratings\.visible_rank_score IS NOT NULL/);
  assert.match(sql, /competitive_ratings\.visible_rank_score DESC/);
  assert.doesNotMatch(sql, /competitive_ratings\.mmr/);
  assert.match(sql, /LIMIT 10/);
  assert.doesNotMatch(sql, /FROM games/);
  assert.doesNotMatch(sql, /game_players/);
});

test("caps Ranked standings at ten players", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    username: `player-${index + 1}`,
    avatarId: "cat",
    visibleRankScore: 1_600 - index * 20,
  }));
  const query: RankedLeaderboardQuery = async () => ({ rows });

  const entries = await rankedLeaderboard("EASY", query);

  assert.equal(entries.length, 10);
  assert.deepEqual(
    entries.map(({ rank, label, lp }) => ({ rank, label, lp })),
    rows.slice(0, 10).map(({ visibleRankScore }, index) => ({
      rank: index + 1,
      label: visibleRankScore >= 1_500 ? "Master" : "Diamond I",
      lp:
        visibleRankScore >= 1_500
          ? visibleRankScore - 1_500
          : visibleRankScore - 1_400,
    })),
  );
});
