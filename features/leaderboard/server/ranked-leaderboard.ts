import { databasePool } from "../../database/server/client";
import type { GameDifficulty } from "../../game/single-player";
import {
  rankedProgress,
  type RankedDivision,
  type RankedTier,
} from "../../rating/server/ranked-visible-progression";

type RankedLeaderboardDatabaseRow = {
  username: string;
  avatarId: string;
  visibleRankScore: number;
};

export type RankedLeaderboardEntry = {
  rank: number;
  username: string;
  avatarId: string;
  tier: RankedTier;
  division: RankedDivision | null;
  label: string;
  lp: number;
};

export type RankedLeaderboardQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: RankedLeaderboardDatabaseRow[] }>;

const RANKED_LEADERBOARD_SQL = `
  SELECT
    users.username,
    users.avatar_id AS "avatarId",
    competitive_ratings.visible_rank_score AS "visibleRankScore"
  FROM competitive_ratings
  JOIN users ON users.id = competitive_ratings.user_id
  WHERE competitive_ratings.difficulty = $1
    AND competitive_ratings.ranked_games_completed = 10
    AND competitive_ratings.visible_rank_score IS NOT NULL
  ORDER BY
    competitive_ratings.visible_rank_score DESC,
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

  return result.rows.slice(0, 10).map((row, index) => {
    const progress = rankedProgress(10, row.visibleRankScore);
    if (progress.status !== "RANKED") {
      throw new Error("Ranked leaderboard row is not placement-complete.");
    }
    return {
      rank: index + 1,
      username: row.username,
      avatarId: row.avatarId,
      tier: progress.tier,
      division: progress.division,
      label: progress.label,
      lp: progress.lp,
    };
  });
}
