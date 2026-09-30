import { databasePool } from "../../database/server/client";
import type { GameDifficulty } from "../../game/single-player";

type ProfileSummaryDatabaseRow = {
  bestScore: number;
  completedGames: number;
  averageScore: number;
  perfectRounds: number;
  zeroRounds: number;
};

type ProfileRunDatabaseRow = {
  gameId: string;
  score: number;
  completedAt: Date | null;
};

export type ProfileTopRun = {
  gameId: string;
  score: number;
  completedAt: string | null;
};

export type SingleProfileStats = {
  bestScore: number;
  completedGames: number;
  averageScore: number;
  perfectRounds: number;
  zeroRounds: number;
  topRuns: ProfileTopRun[];
};

export type ProfileStatsQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

const SINGLE_PROFILE_SUMMARY_SQL = `
  WITH completed_games AS (
    SELECT
      games.id AS game_id,
      game_players.id AS game_player_id,
      game_players.total_score
    FROM games
    JOIN game_players ON game_players.game_id = games.id
    WHERE game_players.user_id = $1
      AND games.type = 'SINGLE'
      AND games.status = 'COMPLETED'
      AND games.difficulty = $2
      AND game_players.total_score IS NOT NULL
  )
  SELECT
    COALESCE(MAX(total_score), 0)::integer AS "bestScore",
    COUNT(*)::integer AS "completedGames",
    COALESCE(ROUND(AVG(total_score)), 0)::integer AS "averageScore",
    (
      SELECT COUNT(*)::integer
      FROM completed_games
      JOIN rounds ON rounds.game_id = completed_games.game_id
      JOIN round_results
        ON round_results.round_id = rounds.id
        AND round_results.game_player_id = completed_games.game_player_id
      WHERE round_results.score = 10000
    ) AS "perfectRounds",
    (
      SELECT COUNT(*)::integer
      FROM completed_games
      JOIN rounds ON rounds.game_id = completed_games.game_id
      JOIN round_results
        ON round_results.round_id = rounds.id
        AND round_results.game_player_id = completed_games.game_player_id
      WHERE round_results.score = 0
    ) AS "zeroRounds"
  FROM completed_games
`;

const SINGLE_PROFILE_TOP_RUNS_SQL = `
  SELECT
    games.id AS "gameId",
    game_players.total_score AS score,
    games.ended_at AS "completedAt"
  FROM games
  JOIN game_players ON game_players.game_id = games.id
  WHERE game_players.user_id = $1
    AND games.type = 'SINGLE'
    AND games.status = 'COMPLETED'
    AND games.difficulty = $2
    AND game_players.total_score IS NOT NULL
  ORDER BY
    game_players.total_score DESC,
    games.ended_at ASC NULLS LAST,
    games.id ASC
  LIMIT 3
`;

const runProfileStatsQuery: ProfileStatsQuery = async (text, values) => {
  const result = await databasePool().query<Record<string, unknown>>(text, [
    ...values,
  ]);
  return { rows: result.rows };
};

export async function singleProfileStats(
  userId: string,
  difficulty: GameDifficulty,
  query: ProfileStatsQuery = runProfileStatsQuery,
): Promise<SingleProfileStats> {
  const values = [userId, difficulty] as const;
  const [summaryResult, runsResult] = await Promise.all([
    query(SINGLE_PROFILE_SUMMARY_SQL, values),
    query(SINGLE_PROFILE_TOP_RUNS_SQL, values),
  ]);
  const summary = summaryResult.rows[0] as
    | ProfileSummaryDatabaseRow
    | undefined;

  return {
    bestScore: summary?.bestScore ?? 0,
    completedGames: summary?.completedGames ?? 0,
    averageScore: summary?.averageScore ?? 0,
    perfectRounds: summary?.perfectRounds ?? 0,
    zeroRounds: summary?.zeroRounds ?? 0,
    topRuns: runsResult.rows.slice(0, 3).map((row) => {
      const run = row as ProfileRunDatabaseRow;
      return {
        gameId: run.gameId,
        score: run.score,
        completedAt: run.completedAt?.toISOString() ?? null,
      };
    }),
  };
}
