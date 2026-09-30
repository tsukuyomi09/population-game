import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteUserAndOwnedData,
  type AccountDeletionTransaction,
} from "./server/account-deletion";
import {
  singleProfileStats,
  type ProfileStatsQuery,
} from "./server/profile-stats";

function normalizedSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

test("derives completed Single profile stats by user and difficulty", async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query: ProfileStatsQuery = async (text, values) => {
    calls.push({ text, values });

    if (text.includes("LIMIT 3")) {
      return {
        rows: [
          {
            gameId: "game-1",
            score: 48_000,
            completedAt: new Date("2026-01-02T00:00:00.000Z"),
          },
          {
            gameId: "game-2",
            score: 45_000,
            completedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      };
    }

    return {
      rows: [
        {
          bestScore: 48_000,
          completedGames: 4,
          averageScore: 41_250,
          perfectRounds: 3,
          zeroRounds: 1,
        },
      ],
    };
  };

  const stats = await singleProfileStats("user-1", "REAL", query);

  assert.deepEqual(
    calls.map((call) => call.values),
    [
      ["user-1", "REAL"],
      ["user-1", "REAL"],
    ],
  );
  for (const call of calls) {
    const sql = normalizedSql(call.text);
    assert.match(sql, /game_players\.user_id = \$1/);
    assert.match(sql, /games\.type = 'SINGLE'/);
    assert.match(sql, /games\.status = 'COMPLETED'/);
    assert.match(sql, /games\.difficulty = \$2/);
  }
  assert.deepEqual(stats, {
    bestScore: 48_000,
    completedGames: 4,
    averageScore: 41_250,
    perfectRounds: 3,
    zeroRounds: 1,
    topRuns: [
      {
        gameId: "game-1",
        score: 48_000,
        completedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        gameId: "game-2",
        score: 45_000,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
  assert.match(normalizedSql(calls[1].text), /LIMIT 3/);
});

test("returns zero profile stats when no completed runs exist", async () => {
  const query: ProfileStatsQuery = async (text) => ({
    rows: text.includes("LIMIT 3") ? [] : [],
  });

  assert.deepEqual(await singleProfileStats("user-1", "EASY", query), {
    bestScore: 0,
    completedGames: 0,
    averageScore: 0,
    perfectRounds: 0,
    zeroRounds: 0,
    topRuns: [],
  });
});

test("deletes user-owned data and orphaned Single games transactionally", async () => {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  let transactionCalls = 0;
  const transaction: AccountDeletionTransaction = async (work) => {
    transactionCalls += 1;

    return work(async (text, values = []) => {
      calls.push({ text: normalizedSql(text), values });

      if (text.includes("SELECT id FROM users")) {
        return { rows: [{ id: "user-1" }], rowCount: 1 };
      }
      if (text.includes("SELECT DISTINCT game_id")) {
        return { rows: [{ gameId: "game-1" }], rowCount: 1 };
      }
      if (text.includes("FROM games") && text.includes("NOT EXISTS")) {
        return { rows: [{ gameId: "game-1" }], rowCount: 1 };
      }
      if (text.includes("DELETE FROM users")) {
        return { rows: [{ id: "user-1" }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });
  };

  assert.equal(
    await deleteUserAndOwnedData("user-1", transaction),
    true,
  );
  assert.equal(transactionCalls, 1);

  const sql = calls.map((call) => call.text).join(" | ");
  assert.match(sql, /DELETE FROM round_results/);
  assert.match(sql, /DELETE FROM competitive_ratings WHERE user_id = \$1/);
  assert.match(sql, /DELETE FROM game_players WHERE user_id = \$1/);
  assert.match(sql, /DELETE FROM rounds WHERE game_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(sql, /DELETE FROM games WHERE id = ANY\(\$1::uuid\[\]\)/);
  assert.match(sql, /DELETE FROM users WHERE id = \$1 RETURNING id/);
});

test("preserves a shared game that still has another participant", async () => {
  const calls: string[] = [];
  const transaction: AccountDeletionTransaction = async (work) =>
    work(async (text) => {
      const sql = normalizedSql(text);
      calls.push(sql);

      if (sql.includes("SELECT id FROM users")) {
        return { rows: [{ id: "user-1" }], rowCount: 1 };
      }
      if (sql.includes("SELECT DISTINCT game_id")) {
        return { rows: [{ gameId: "shared-game" }], rowCount: 1 };
      }
      if (sql.includes("FROM games") && sql.includes("NOT EXISTS")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("DELETE FROM users")) {
        return { rows: [{ id: "user-1" }], rowCount: 1 };
      }

      return { rows: [], rowCount: 1 };
    });

  assert.equal(await deleteUserAndOwnedData("user-1", transaction), true);
  assert.equal(calls.some((sql) => sql.startsWith("DELETE FROM rounds")), false);
  assert.equal(calls.some((sql) => sql.startsWith("DELETE FROM games")), false);
});
