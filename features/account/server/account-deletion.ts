import { databasePool } from "../../database/server/client";

type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
};

export type AccountDeletionQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<QueryResult>;

export type AccountDeletionTransaction = <T>(
  work: (query: AccountDeletionQuery) => Promise<T>,
) => Promise<T>;

const postgresTransaction: AccountDeletionTransaction = async (work) => {
  const client = await databasePool().connect();

  try {
    await client.query("BEGIN");
    const result = await work(async (text, values = []) => {
      const queryResult = await client.query<Record<string, unknown>>(text, [
        ...values,
      ]);
      return { rows: queryResult.rows, rowCount: queryResult.rowCount };
    });
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

export async function deleteUserAndOwnedData(
  userId: string,
  transaction: AccountDeletionTransaction = postgresTransaction,
) {
  return transaction(async (query) => {
    const lockedUser = await query(
      `SELECT id FROM users WHERE id = $1 FOR UPDATE`,
      [userId],
    );
    if (lockedUser.rowCount !== 1) return false;

    const games = await query(
      `
        SELECT DISTINCT game_id AS "gameId"
        FROM game_players
        WHERE user_id = $1
      `,
      [userId],
    );
    const gameIds = games.rows.map((row) => row.gameId as string);

    await query(
      `
        DELETE FROM round_results
        WHERE game_player_id IN (
          SELECT id FROM game_players WHERE user_id = $1
        )
      `,
      [userId],
    );
    await query(`DELETE FROM competitive_ratings WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM game_players WHERE user_id = $1`, [userId]);

    if (gameIds.length > 0) {
      const orphanGames = await query(
        `
          SELECT games.id AS "gameId"
          FROM games
          WHERE games.id = ANY($1::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM game_players WHERE game_players.game_id = games.id
            )
          FOR UPDATE
        `,
        [gameIds],
      );
      const orphanGameIds = orphanGames.rows.map((row) => row.gameId as string);

      if (orphanGameIds.length > 0) {
        await query(
          `
            DELETE FROM round_results
            WHERE round_id IN (
              SELECT id FROM rounds WHERE game_id = ANY($1::uuid[])
            )
          `,
          [orphanGameIds],
        );
        await query(`DELETE FROM rounds WHERE game_id = ANY($1::uuid[])`, [
          orphanGameIds,
        ]);
        await query(`DELETE FROM games WHERE id = ANY($1::uuid[])`, [
          orphanGameIds,
        ]);
      }
    }

    const deletedUser = await query(
      `DELETE FROM users WHERE id = $1 RETURNING id`,
      [userId],
    );
    return deletedUser.rowCount === 1;
  });
}
