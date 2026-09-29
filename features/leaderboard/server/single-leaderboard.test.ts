import assert from "node:assert/strict";
import test from "node:test";
import {
  singleLeaderboard,
  type SingleLeaderboardQuery,
} from "./single-leaderboard";

const completedAt = new Date("2026-01-01T00:00:00.000Z");

function recordingQuery(rows: Awaited<ReturnType<SingleLeaderboardQuery>>["rows"]) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query: SingleLeaderboardQuery = async (text, values) => {
    calls.push({ text, values });
    return { rows };
  };

  return { calls, query };
}

function normalizedSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

test("keeps EASY and REAL leaderboard queries separate", async () => {
  const recorded = recordingQuery([]);

  await singleLeaderboard("EASY", recorded.query);
  await singleLeaderboard("REAL", recorded.query);

  assert.deepEqual(
    recorded.calls.map((call) => call.values),
    [["EASY"], ["REAL"]],
  );
  assert.match(normalizedSql(recorded.calls[0].text), /games\.difficulty = \$1/);
});

test("selects only completed Single games and excludes abandoned games", async () => {
  const recorded = recordingQuery([]);

  await singleLeaderboard("EASY", recorded.query);

  const sql = normalizedSql(recorded.calls[0].text);
  assert.match(sql, /games\.type = 'SINGLE'/);
  assert.match(sql, /games\.status = 'COMPLETED'/);
  assert.doesNotMatch(sql, /status = 'ABANDONED'/);
});

test("preserves multiple completed runs from the same user", async () => {
  const recorded = recordingQuery([
    {
      gameId: "game-1",
      username: "mapmaker",
      avatarId: "cat",
      score: 49_000,
      completedAt,
    },
    {
      gameId: "game-2",
      username: "mapmaker",
      avatarId: "cat",
      score: 48_000,
      completedAt,
    },
  ]);

  const entries = await singleLeaderboard("REAL", recorded.query);

  assert.deepEqual(entries.map((entry) => entry.username), [
    "mapmaker",
    "mapmaker",
  ]);
  assert.deepEqual(entries.map((entry) => entry.rank), [1, 2]);
});

test("orders by score and returns at most the Top 10", async () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    gameId: `game-${index + 1}`,
    username: `player-${index + 1}`,
    avatarId: "dog",
    score: 50_000 - index * 100,
    completedAt,
  }));
  const recorded = recordingQuery(rows);

  const entries = await singleLeaderboard("EASY", recorded.query);
  const sql = normalizedSql(recorded.calls[0].text);

  assert.equal(entries.length, 10);
  assert.deepEqual(entries.map((entry) => entry.score), rows.slice(0, 10).map((row) => row.score));
  assert.match(
    sql,
    /ORDER BY game_players\.total_score DESC, games\.ended_at ASC NULLS LAST, games\.id ASC LIMIT 10/,
  );
});
