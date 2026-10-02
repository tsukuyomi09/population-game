import { databasePool } from "../../database/server/client";
import type { GameDifficulty } from "../../game/single-player";
import { rankedProgress, type RankedProgress } from "./ranked-visible-progression";

export type CurrentRankedProgress = RankedProgress & {
  difficulty: GameDifficulty;
};

export type CurrentRankedProgressByDifficulty = Record<
  GameDifficulty,
  CurrentRankedProgress
>;

export type RankedProgressQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

const CURRENT_RANKED_PROGRESS_SQL = `
  SELECT difficulty,
         ranked_games_completed AS "rankedGamesCompleted",
         visible_rank_score AS "visibleRankScore"
  FROM competitive_ratings
  WHERE user_id = $1
    AND difficulty IN ('EASY', 'REAL')
`;

const runRankedProgressQuery: RankedProgressQuery = async (text, values) => {
  const result = await databasePool().query<Record<string, unknown>>(text, [
    ...values,
  ]);
  return { rows: result.rows };
};

function initialProgress(difficulty: GameDifficulty): CurrentRankedProgress {
  return { difficulty, ...rankedProgress(0, null) };
}

export async function currentRankedProgress(
  userId: string,
  query: RankedProgressQuery = runRankedProgressQuery,
): Promise<CurrentRankedProgressByDifficulty> {
  const progress: CurrentRankedProgressByDifficulty = {
    EASY: initialProgress("EASY"),
    REAL: initialProgress("REAL"),
  };
  const result = await query(CURRENT_RANKED_PROGRESS_SQL, [userId]);

  for (const row of result.rows) {
    if (row.difficulty !== "EASY" && row.difficulty !== "REAL") continue;
    if (
      typeof row.rankedGamesCompleted !== "number" ||
      !Number.isInteger(row.rankedGamesCompleted)
    ) {
      continue;
    }
    if (
      row.visibleRankScore !== null &&
      (typeof row.visibleRankScore !== "number" ||
        !Number.isInteger(row.visibleRankScore))
    ) {
      continue;
    }

    progress[row.difficulty] = {
      difficulty: row.difficulty,
      ...rankedProgress(
        row.rankedGamesCompleted,
        row.visibleRankScore as number | null,
      ),
    };
  }

  return progress;
}
