import { databasePool } from "../../database/server/client";
import type { GameDifficulty } from "../../game/single-player";

type SingleLeaderboardDatabaseRow = {
  gameId: string;
  username: string;
  avatarId: string;
  score: number;
  completedAt: Date | null;
};

export type SingleLeaderboardEntry = {
  rank: number;
  gameId: string;
  username: string;
  avatarId: string;
  score: number;
  completedAt: string | null;
};

export type SingleLeaderboardQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: SingleLeaderboardDatabaseRow[] }>;

const SINGLE_LEADERBOARD_SQL = `
  SELECT
    games.id AS "gameId",
    users.username,
    users.avatar_id AS "avatarId",
    game_players.total_score AS score,
    games.ended_at AS "completedAt"
  FROM games
  JOIN game_players ON game_players.game_id = games.id
  JOIN users ON users.id = game_players.user_id
  WHERE games.type = 'SINGLE'
    AND games.status = 'COMPLETED'
    AND games.difficulty = $1
    AND game_players.total_score IS NOT NULL
  ORDER BY
    game_players.total_score DESC,
    games.ended_at ASC NULLS LAST,
    games.id ASC
  LIMIT 10
`;

const runLeaderboardQuery: SingleLeaderboardQuery = async (text, values) =>
  databasePool().query<SingleLeaderboardDatabaseRow>(text, [...values]);

export async function singleLeaderboard(
  difficulty: GameDifficulty,
  query: SingleLeaderboardQuery = runLeaderboardQuery,
): Promise<SingleLeaderboardEntry[]> {
  const result = await query(SINGLE_LEADERBOARD_SQL, [difficulty]);

  return result.rows.slice(0, 10).map((row, index) => ({
    rank: index + 1,
    gameId: row.gameId,
    username: row.username,
    avatarId: row.avatarId,
    score: row.score,
    completedAt: row.completedAt?.toISOString() ?? null,
  }));
}
