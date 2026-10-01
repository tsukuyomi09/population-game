import { databasePool } from "../../database/server/client";
import type { GameDifficulty } from "../../game/single-player";

export const INITIAL_RANKED_RATING = 1_000;
export const MINIMUM_RANKED_RATING = 400;

export type CurrentRankedRating = {
  difficulty: GameDifficulty;
  rating: number;
  established: boolean;
};

export type CurrentRankedRatings = Record<
  GameDifficulty,
  CurrentRankedRating
>;

export type RankedRatingsQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

const CURRENT_RANKED_RATINGS_SQL = `
  SELECT difficulty, rating
  FROM competitive_ratings
  WHERE user_id = $1
    AND difficulty IN ('EASY', 'REAL')
`;

const runRankedRatingsQuery: RankedRatingsQuery = async (text, values) => {
  const result = await databasePool().query<Record<string, unknown>>(text, [
    ...values,
  ]);
  return { rows: result.rows };
};

function initialRating(difficulty: GameDifficulty): CurrentRankedRating {
  return {
    difficulty,
    rating: INITIAL_RANKED_RATING,
    established: false,
  };
}

export async function currentRankedRatings(
  userId: string,
  query: RankedRatingsQuery = runRankedRatingsQuery,
): Promise<CurrentRankedRatings> {
  const ratings: CurrentRankedRatings = {
    EASY: initialRating("EASY"),
    REAL: initialRating("REAL"),
  };
  const result = await query(CURRENT_RANKED_RATINGS_SQL, [userId]);

  for (const row of result.rows) {
    if (row.difficulty !== "EASY" && row.difficulty !== "REAL") continue;
    if (typeof row.rating !== "number" || !Number.isInteger(row.rating)) {
      continue;
    }

    ratings[row.difficulty] = {
      difficulty: row.difficulty,
      rating: Math.max(MINIMUM_RANKED_RATING, row.rating),
      established: true,
    };
  }

  return ratings;
}
