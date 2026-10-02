import { databasePool } from "../../database/server/client";
import type { GameDifficulty } from "../../game/single-player";
import { INITIAL_RANKED_MMR, MINIMUM_RANKED_MMR } from "./ranked-mmr";

export type RankedMmrQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: Record<string, unknown>[] }>;

const CURRENT_RANKED_MMR_SQL = `
  SELECT mmr
  FROM competitive_ratings
  WHERE user_id = $1
    AND difficulty = $2
`;

const runRankedMmrQuery: RankedMmrQuery = async (text, values) => {
  const result = await databasePool().query<Record<string, unknown>>(text, [
    ...values,
  ]);
  return { rows: result.rows };
};

export async function currentRankedMmr(
  userId: string,
  difficulty: GameDifficulty,
  query: RankedMmrQuery = runRankedMmrQuery,
) {
  const result = await query(CURRENT_RANKED_MMR_SQL, [userId, difficulty]);
  const mmr = result.rows[0]?.mmr;

  if (mmr === undefined) return INITIAL_RANKED_MMR;
  if (!Number.isInteger(mmr) || (mmr as number) < MINIMUM_RANKED_MMR) {
    throw new Error("Stored Ranked MMR is invalid.");
  }
  return mmr as number;
}
