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

type DuelOutcomeDatabaseRow = Pick<
  DuelProfileStats,
  "wins" | "losses" | "draws"
>;

type DuelRoundStatsDatabaseRow = Pick<
  DuelProfileStats,
  "perfectRounds" | "zeroRounds"
>;

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

export type DuelProfileMode = "DUEL" | "RANKED";

export type DuelProfileStats = {
  wins: number;
  losses: number;
  draws: number;
  perfectRounds: number;
  zeroRounds: number;
};

export type DuelProfileStatsByDifficulty = Record<
  GameDifficulty,
  Record<DuelProfileMode, DuelProfileStats>
>;

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

const DUEL_PROFILE_OUTCOMES_SQL = `
  /* duel-profile:outcomes */
  SELECT
    (COUNT(*) FILTER (WHERE game_players.result = 'WIN'))::integer AS wins,
    (COUNT(*) FILTER (WHERE game_players.result = 'LOSS'))::integer AS losses,
    (COUNT(*) FILTER (WHERE game_players.result = 'DRAW'))::integer AS draws
  FROM games
  JOIN game_players ON game_players.game_id = games.id
  WHERE game_players.user_id = $1
    AND games.type = 'DUEL'
    AND games.status = 'COMPLETED'
    AND games.difficulty = $2
    AND games.rated = $3
    AND EXISTS (
      SELECT 1
      FROM game_players AS opponent
      WHERE opponent.game_id = games.id
        AND opponent.id <> game_players.id
    )
`;

const DUEL_PROFILE_ROUND_STATS_SQL = `
  /* duel-profile:round-stats */
  WITH eligible_duels AS (
    SELECT
      games.id AS game_id,
      game_players.id AS game_player_id
    FROM games
    JOIN game_players ON game_players.game_id = games.id
    WHERE game_players.user_id = $1
      AND games.type = 'DUEL'
      AND games.status = 'COMPLETED'
      AND games.difficulty = $2
      AND games.rated = $3
      AND EXISTS (
        SELECT 1
        FROM game_players AS opponent
        WHERE opponent.game_id = games.id
          AND opponent.id <> game_players.id
      )
  )
  SELECT
    (COUNT(round_results.id) FILTER (
      WHERE round_results.score = 10000
    ))::integer AS "perfectRounds",
    (COUNT(round_results.id) FILTER (
      WHERE round_results.score = 0
    ))::integer AS "zeroRounds"
  FROM eligible_duels
  LEFT JOIN rounds ON rounds.game_id = eligible_duels.game_id
  LEFT JOIN round_results
    ON round_results.round_id = rounds.id
    AND round_results.game_player_id = eligible_duels.game_player_id
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

export async function duelProfileStats(
  userId: string,
  difficulty: GameDifficulty,
  mode: DuelProfileMode,
  query: ProfileStatsQuery = runProfileStatsQuery,
): Promise<DuelProfileStats> {
  const values = [userId, difficulty, mode === "RANKED"] as const;
  const [outcomesResult, roundStatsResult] = await Promise.all([
    query(DUEL_PROFILE_OUTCOMES_SQL, values),
    query(DUEL_PROFILE_ROUND_STATS_SQL, values),
  ]);
  const outcomes = outcomesResult.rows[0] as
    | Partial<DuelOutcomeDatabaseRow>
    | undefined;
  const roundStats = roundStatsResult.rows[0] as
    | Partial<DuelRoundStatsDatabaseRow>
    | undefined;

  return {
    wins: outcomes?.wins ?? 0,
    losses: outcomes?.losses ?? 0,
    draws: outcomes?.draws ?? 0,
    perfectRounds: roundStats?.perfectRounds ?? 0,
    zeroRounds: roundStats?.zeroRounds ?? 0,
  };
}
