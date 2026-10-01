import "server-only";
import type { PoolClient } from "pg";
import { databasePool } from "../../database/server/client";
import type { SingleGamePersistence } from "./single-game-service";

async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await databasePool().connect();

  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockedSingleGame(
  client: PoolClient,
  gameId: string,
  gamePlayerId: string,
) {
  const result = await client.query<{
    status: "ACTIVE" | "COMPLETED" | "ABANDONED";
  }>(
    `
      SELECT games.status
      FROM games
      JOIN game_players ON game_players.game_id = games.id
      WHERE games.id = $1
        AND game_players.id = $2
        AND games.type = 'SINGLE'
      FOR UPDATE OF games, game_players
    `,
    [gameId, gamePlayerId],
  );

  const game = result.rows[0];
  if (!game) throw new Error("Persistent Single game not found.");
  return game;
}

export const singleGamePersistence: SingleGamePersistence = {
  async createGame(input) {
    return transaction(async (client) => {
      await client.query(
        `
          UPDATE games
          SET status = 'ABANDONED',
              end_reason = 'PLAYER_ABANDON',
              ended_at = $2::timestamptz
          WHERE games.type = 'SINGLE'
            AND games.status = 'ACTIVE'
            AND games.started_at < $2::timestamptz - INTERVAL '1 hour'
            AND EXISTS (
              SELECT 1
              FROM game_players
              WHERE game_players.game_id = games.id
                AND game_players.user_id = $1
            )
        `,
        [input.userId, input.startedAt],
      );

      const game = await client.query<{ id: string }>(
        `
          INSERT INTO games (
            type, difficulty, rated, status, end_reason, started_at
          )
          VALUES ('SINGLE', $1, false, 'ACTIVE', NULL, $2)
          RETURNING id
        `,
        [input.difficulty, input.startedAt],
      );
      const gameId = game.rows[0].id;

      const player = await client.query<{ id: string }>(
        `
          INSERT INTO game_players (game_id, user_id)
          VALUES ($1, $2)
          RETURNING id
        `,
        [gameId, input.userId],
      );
      const gamePlayerId = player.rows[0].id;

      const round = await client.query<{ id: string }>(
        `
          INSERT INTO rounds (
            game_id, round_number, target_population, started_at
          )
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `,
        [gameId, input.roundNumber, input.targetPopulation, input.startedAt],
      );

      return { gameId, gamePlayerId, roundId: round.rows[0].id };
    });
  },

  async createRound(input) {
    return transaction(async (client) => {
      const game = await lockedSingleGame(
        client,
        input.gameId,
        input.gamePlayerId,
      );
      if (game.status !== "ACTIVE") {
        throw new Error("Cannot create a round for a finished game.");
      }

      const previousResult = await client.query(
        `
          SELECT 1
          FROM rounds
          JOIN round_results ON round_results.round_id = rounds.id
          WHERE rounds.game_id = $1
            AND rounds.round_number = $2
            AND round_results.game_player_id = $3
        `,
        [input.gameId, input.roundNumber - 1, input.gamePlayerId],
      );
      if (previousResult.rowCount !== 1) {
        throw new Error("The previous round is not resolved.");
      }

      const round = await client.query<{ id: string }>(
        `
          INSERT INTO rounds (
            game_id, round_number, target_population, started_at
          )
          VALUES ($1, $2, $3, $4)
          RETURNING id
        `,
        [
          input.gameId,
          input.roundNumber,
          input.targetPopulation,
          input.startedAt,
        ],
      );

      return { roundId: round.rows[0].id };
    });
  },

  async resolveRound(input) {
    return transaction(async (client) => {
      const game = await lockedSingleGame(
        client,
        input.gameId,
        input.gamePlayerId,
      );
      if (game.status !== "ACTIVE") {
        throw new Error("Cannot resolve a round for a finished game.");
      }

      const round = await client.query<{ roundNumber: number }>(
        `
          SELECT round_number AS "roundNumber"
          FROM rounds
          WHERE id = $1 AND game_id = $2
          FOR UPDATE
        `,
        [input.roundId, input.gameId],
      );
      if (round.rows[0]?.roundNumber !== input.roundNumber) {
        throw new Error("Persistent round does not belong to the active game.");
      }

      await client.query(
        `
          INSERT INTO round_results (
            round_id,
            game_player_id,
            calculated_population,
            score,
            submission_type,
            submitted_at
          )
          VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          input.roundId,
          input.gamePlayerId,
          input.calculatedPopulation,
          input.score,
          input.submissionType,
          input.submittedAt,
        ],
      );

      const totals = await client.query<{ totalScore: number; resultCount: number }>(
        `
          SELECT
            COALESCE(SUM(score), 0)::integer AS "totalScore",
            COUNT(*)::integer AS "resultCount"
          FROM round_results
          WHERE game_player_id = $1
        `,
        [input.gamePlayerId],
      );
      const { totalScore, resultCount } = totals.rows[0];

      if (input.completeGame) {
        if (input.roundNumber !== 5 || resultCount !== 5) {
          throw new Error("A completed Single game must have five results.");
        }

        await client.query(
          `UPDATE game_players SET total_score = $2 WHERE id = $1`,
          [input.gamePlayerId, totalScore],
        );
        const completed = await client.query(
          `
            UPDATE games
            SET status = 'COMPLETED', end_reason = 'NORMAL', ended_at = $2
            WHERE id = $1 AND status = 'ACTIVE'
          `,
          [input.gameId, input.submittedAt],
        );
        if (completed.rowCount !== 1) {
          throw new Error("The Single game was already finalized.");
        }
      }

      return { totalScore };
    });
  },

  async abandonGame(input) {
    return transaction(async (client) => {
      const game = await lockedSingleGame(
        client,
        input.gameId,
        input.gamePlayerId,
      );
      if (game.status !== "ACTIVE") {
        throw new Error("The Single game was already finalized.");
      }

      const totals = await client.query<{ totalScore: number }>(
        `
          SELECT COALESCE(SUM(score), 0)::integer AS "totalScore"
          FROM round_results
          WHERE game_player_id = $1
        `,
        [input.gamePlayerId],
      );
      const { totalScore } = totals.rows[0];

      await client.query(
        `UPDATE game_players SET total_score = $2 WHERE id = $1`,
        [input.gamePlayerId, totalScore],
      );
      const abandoned = await client.query(
        `
          UPDATE games
          SET status = 'ABANDONED',
              end_reason = 'PLAYER_ABANDON',
              ended_at = $2
          WHERE id = $1 AND status = 'ACTIVE'
        `,
        [input.gameId, input.endedAt],
      );
      if (abandoned.rowCount !== 1) {
        throw new Error("The Single game was already finalized.");
      }

      return { totalScore };
    });
  },
};
