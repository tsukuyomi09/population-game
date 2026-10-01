import { databasePool } from "../../database/server/client";
import type { GameDifficulty } from "../../game/single-player";

type RankedLeaderboardDatabaseRow = {
  username: string;
  avatarId: string;
  rating: number;
};

export type RankedLeaderboardEntry = {
  rank: number;
  username: string;
  avatarId: string;
  rating: number;
};

export type RankedLeaderboardQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: RankedLeaderboardDatabaseRow[] }>;

const RANKED_LEADERBOARD_SQL = `
  SELECT
    users.username,
    users.avatar_id AS "avatarId",
    competitive_ratings.rating
  FROM competitive_ratings
  JOIN users ON users.id = competitive_ratings.user_id
  WHERE competitive_ratings.difficulty = $1
  ORDER BY
    competitive_ratings.rating DESC,
    users.username ASC,
    competitive_ratings.user_id ASC
  LIMIT 10
`;

const runLeaderboardQuery: RankedLeaderboardQuery = async (text, values) =>
  databasePool().query<RankedLeaderboardDatabaseRow>(text, [...values]);

export async function rankedLeaderboard(
  difficulty: GameDifficulty,
  query: RankedLeaderboardQuery = runLeaderboardQuery,
): Promise<RankedLeaderboardEntry[]> {
  const result = await query(RANKED_LEADERBOARD_SQL, [difficulty]);

  return result.rows.slice(0, 10).map((row, index) => ({
    rank: index + 1,
    username: row.username,
    avatarId: row.avatarId,
    rating: row.rating,
  }));
}
