import { databasePool } from "../../database/server/client";
import type { RuntimePlayer } from "../../game/runtime-player";
import type { RuntimeRoundSnapshot } from "../../game/server/runtime-game";
import type { GameDifficulty } from "../../game/single-player";
import {
  calculateRankedMmrUpdate,
  INITIAL_RANKED_MMR,
  RANKED_PLACEMENT_GAMES,
} from "./ranked-mmr";
import {
  rankedProgress,
  type RankedProgress,
  visibleRankScoreAfterMatch,
  visibleRankScoreFromMmr,
} from "./ranked-visible-progression";

export type RankedDuelOutcome = "WIN" | "LOSS" | "DRAW";
export type RankedDuelCompletionReason = "ROUNDS_COMPLETE" | "ABANDON";

export type RankedDuelFinalizationInput = {
  runtimeGameId: string;
  difficulty: GameDifficulty;
  rated: boolean;
  players: readonly [
    { player: RuntimePlayer; totalScore: number },
    { player: RuntimePlayer; totalScore: number },
  ];
  rounds: readonly RuntimeRoundSnapshot[];
  completionReason: RankedDuelCompletionReason;
  abandonedRuntimePlayerId?: string;
  startedAt: Date;
  endedAt: Date;
};

export type RankedDuelCompetitiveChange = {
  userId: string;
  outcome: RankedDuelOutcome;
  progressBefore: RankedProgress;
  progressAfter: RankedProgress;
  lpChange: number | null;
};

export type RankedDuelFinalizationResult =
  | { status: "SKIPPED_RUNTIME_ONLY" }
  | { status: "DUPLICATE" }
  | {
      status: "APPLIED";
      competitiveChanges: RankedDuelCompetitiveChange[];
    };

type QueryResult = {
  rows: Record<string, unknown>[];
  rowCount: number | null;
};

export type RankedDuelQuery = (
  text: string,
  values?: readonly unknown[],
) => Promise<QueryResult>;

export type RankedDuelTransaction = <T>(
  work: (query: RankedDuelQuery) => Promise<T>,
) => Promise<T>;

export class RankedDuelEligibilityError extends Error {}

const postgresTransaction: RankedDuelTransaction = async (work) => {
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

function playerOutcomes(input: RankedDuelFinalizationInput) {
  const [first, second] = input.players;

  if (input.completionReason === "ABANDON") {
    const abandonedId = input.abandonedRuntimePlayerId;
    if (
      !abandonedId ||
      !input.players.some(
        ({ player }) => player.runtimePlayerId === abandonedId,
      )
    ) {
      throw new Error("Ranked abandon is missing its abandoning player.");
    }

    return new Map<string, RankedDuelOutcome>([
      [
        first.player.runtimePlayerId,
        first.player.runtimePlayerId === abandonedId ? "LOSS" : "WIN",
      ],
      [
        second.player.runtimePlayerId,
        second.player.runtimePlayerId === abandonedId ? "LOSS" : "WIN",
      ],
    ]);
  }

  const firstOutcome =
    first.totalScore > second.totalScore
      ? "WIN"
      : first.totalScore < second.totalScore
        ? "LOSS"
        : "DRAW";
  const secondOutcome =
    firstOutcome === "WIN" ? "LOSS" : firstOutcome === "LOSS" ? "WIN" : "DRAW";
  return new Map<string, RankedDuelOutcome>([
    [first.player.runtimePlayerId, firstOutcome],
    [second.player.runtimePlayerId, secondOutcome],
  ]);
}

export async function finalizeRankedDuel(
  input: RankedDuelFinalizationInput,
  transaction: RankedDuelTransaction = postgresTransaction,
): Promise<RankedDuelFinalizationResult> {
  if (input.players.some(({ player }) => player.kind !== "registered")) {
    if (input.rated) {
      throw new RankedDuelEligibilityError(
        "A Ranked Duel requires two registered players.",
      );
    }
    return { status: "SKIPPED_RUNTIME_ONLY" };
  }

  const registeredPlayers = input.players.map(({ player, totalScore }) => {
    if (player.kind !== "registered") {
      throw new RankedDuelEligibilityError(
        "A Ranked Duel requires two registered players.",
      );
    }
    if (!Number.isInteger(totalScore) || totalScore < 0) {
      throw new Error("Ranked Duel total score is invalid.");
    }
    return { player, totalScore };
  });
  if (
    registeredPlayers[0].player.userId ===
    registeredPlayers[1].player.userId
  ) {
    throw new RankedDuelEligibilityError(
      "A Ranked Duel requires two distinct registered players.",
    );
  }

  const outcomes = playerOutcomes(input);
  const playersByUserId = [...registeredPlayers].sort((left, right) =>
    left.player.userId.localeCompare(right.player.userId),
  );

  return transaction(async (query) => {
    await query(
      `
        /* ranked-duel:insert-game */
        INSERT INTO games (
          id, type, difficulty, rated, status, end_reason, started_at
        )
        VALUES ($1, 'DUEL', $2, $3, 'ACTIVE', NULL, $4)
        ON CONFLICT (id) DO NOTHING
      `,
      [input.runtimeGameId, input.difficulty, input.rated, input.startedAt],
    );

    const gameResult = await query(
      `
        /* ranked-duel:lock-game */
        SELECT type, difficulty, rated, status
        FROM games
        WHERE id = $1
        FOR UPDATE
      `,
      [input.runtimeGameId],
    );
    const game = gameResult.rows[0];
    if (!game) throw new Error("Persistent Ranked Duel was not found.");
    if (
      game.type !== "DUEL" ||
      game.difficulty !== input.difficulty ||
      game.rated !== input.rated
    ) {
      throw new Error("Persistent game does not match the Ranked Duel.");
    }
    if (game.status !== "ACTIVE") return { status: "DUPLICATE" };

    for (const { player } of playersByUserId) {
      await query(
        `
          /* ranked-duel:insert-player */
          INSERT INTO game_players (game_id, user_id, joined_at)
          VALUES ($1, $2, $3)
          ON CONFLICT (game_id, user_id) DO NOTHING
        `,
        [input.runtimeGameId, player.userId, input.startedAt],
      );
    }

    const gamePlayersResult = await query(
      `
        /* ranked-duel:lock-players */
        SELECT id, user_id AS "userId"
        FROM game_players
        WHERE game_id = $1
        ORDER BY user_id
        FOR UPDATE
      `,
      [input.runtimeGameId],
    );
    const expectedUserIds = playersByUserId.map(({ player }) => player.userId);
    const persistedUserIds = gamePlayersResult.rows.map((row) => row.userId);
    if (
      persistedUserIds.length !== 2 ||
      persistedUserIds.some((userId, index) => userId !== expectedUserIds[index])
    ) {
      throw new Error("Persistent Ranked Duel participants do not match.");
    }

    const rounds = [...input.rounds].sort(
      (left, right) => left.roundNumber - right.roundNumber,
    );
    for (const round of rounds) {
      await query(
        `
          /* ranked-duel:insert-round */
          INSERT INTO rounds (
            game_id, round_number, target_population, started_at, ends_at
          )
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (game_id, round_number) DO NOTHING
        `,
        [
          input.runtimeGameId,
          round.roundNumber,
          round.targetPopulation,
          round.startedAt,
          round.endsAt,
        ],
      );
    }

    const roundsResult = await query(
      `
        /* ranked-duel:lock-rounds */
        SELECT id, round_number AS "roundNumber",
               target_population AS "targetPopulation"
        FROM rounds
        WHERE game_id = $1
        ORDER BY round_number
        FOR UPDATE
      `,
      [input.runtimeGameId],
    );
    if (
      roundsResult.rows.length !== rounds.length ||
      roundsResult.rows.some((row, index) => {
        const expected = rounds[index];
        return (
          row.roundNumber !== expected.roundNumber ||
          Number(row.targetPopulation) !== expected.targetPopulation
        );
      })
    ) {
      throw new Error("Persistent Ranked Duel rounds do not match.");
    }

    const roundIdByNumber = new Map(
      roundsResult.rows.map((row) => [row.roundNumber as number, row.id as string]),
    );
    for (const round of rounds) {
      const roundId = roundIdByNumber.get(round.roundNumber);
      if (!roundId) throw new Error("Persistent Ranked Duel round is missing.");

      for (const playerState of round.players) {
        const resolution = playerState.resolution;
        if (!resolution) continue;
        const player = registeredPlayers.find(
          ({ player }) =>
            player.runtimePlayerId === resolution.runtimePlayerId,
        );
        const gamePlayerId = player
          ? gamePlayersResult.rows.find(
              (row) => row.userId === player.player.userId,
            )?.id
          : undefined;
        if (!gamePlayerId) {
          throw new Error("Ranked Duel round participant does not match.");
        }

        await query(
          `
            /* ranked-duel:insert-round-result */
            INSERT INTO round_results (
              round_id, game_player_id, calculated_population, score,
              submission_type, submitted_at
            )
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (round_id, game_player_id) DO NOTHING
          `,
          [
            roundId,
            gamePlayerId,
            resolution.calculatedPopulation,
            resolution.score,
            resolution.submissionType,
            resolution.resolvedAt,
          ],
        );
      }
    }

    if (!input.rated) {
      for (const { player, totalScore } of playersByUserId) {
        const outcome = outcomes.get(player.runtimePlayerId);
        const gamePlayerId = gamePlayersResult.rows.find(
          (row) => row.userId === player.userId,
        )?.id;
        if (!outcome || !gamePlayerId) {
          throw new Error("Duel finalization state is incomplete.");
        }
        await query(
          `
            /* ranked-duel:update-unrated-player */
            UPDATE game_players
            SET total_score = $2, result = $3
            WHERE id = $1
          `,
          [gamePlayerId, totalScore, outcome],
        );
      }

      const completed = await completeGame(query, input);
      if (completed.rowCount !== 1) {
        throw new Error("Duel was already finalized.");
      }
      return { status: "APPLIED", competitiveChanges: [] };
    }

    for (const { player } of playersByUserId) {
      await query(
        `
          /* ranked-duel:insert-competitive-state */
          INSERT INTO competitive_ratings (
            user_id, difficulty, mmr, ranked_games_completed,
            visible_rank_score, updated_at
          )
          VALUES ($1, $2, $3, 0, NULL, $4)
          ON CONFLICT (user_id, difficulty) DO NOTHING
        `,
        [
          player.userId,
          input.difficulty,
          INITIAL_RANKED_MMR,
          input.endedAt,
        ],
      );
    }

    const competitiveStateResult = await query(
      `
        /* ranked-duel:lock-competitive-state */
        SELECT user_id AS "userId", mmr,
               ranked_games_completed AS "rankedGamesCompleted",
               visible_rank_score AS "visibleRankScore"
        FROM competitive_ratings
        WHERE difficulty = $1
          AND user_id = ANY($2::uuid[])
        ORDER BY user_id
        FOR UPDATE
      `,
      [input.difficulty, expectedUserIds],
    );
    if (competitiveStateResult.rows.length !== 2) {
      throw new Error("Ranked competitive state rows could not be initialized.");
    }

    const competitiveStateByUserId = new Map(
      competitiveStateResult.rows.map((row) => [row.userId as string, row]),
    );
    const gamePlayerIdByUserId = new Map(
      gamePlayersResult.rows.map((row) => [row.userId as string, row.id as string]),
    );
    const changes: RankedDuelCompetitiveChange[] = [];

    for (const { player, totalScore } of playersByUserId) {
      const outcome = outcomes.get(player.runtimePlayerId);
      const competitiveState = competitiveStateByUserId.get(player.userId);
      const opponent = registeredPlayers.find(
        ({ player: candidate }) => candidate.userId !== player.userId,
      );
      const opponentCompetitiveState = opponent
        ? competitiveStateByUserId.get(opponent.player.userId)
        : undefined;
      const gamePlayerId = gamePlayerIdByUserId.get(player.userId);
      if (
        !outcome ||
        !competitiveState ||
        !opponentCompetitiveState ||
        !gamePlayerId
      ) {
        throw new Error("Ranked finalization state is incomplete.");
      }
      const mmrUpdate = calculateRankedMmrUpdate({
        mmr: competitiveState.mmr as number,
        opponentMmr: opponentCompetitiveState.mmr as number,
        rankedGamesCompleted: competitiveState.rankedGamesCompleted as number,
        outcome,
      });
      const visibleRankScoreBefore = competitiveState.visibleRankScore;
      if (
        visibleRankScoreBefore !== null &&
        (typeof visibleRankScoreBefore !== "number" ||
          !Number.isInteger(visibleRankScoreBefore))
      ) {
        throw new Error("Ranked visible progression is invalid.");
      }
      const progressBefore = rankedProgress(
        mmrUpdate.rankedGamesCompletedBefore,
        visibleRankScoreBefore as number | null,
      );
      const visibleRankScoreAfter =
        mmrUpdate.rankedGamesCompletedBefore < RANKED_PLACEMENT_GAMES
          ? mmrUpdate.rankedGamesCompletedAfter === RANKED_PLACEMENT_GAMES
            ? visibleRankScoreFromMmr(mmrUpdate.mmrAfter)
            : null
          : visibleRankScoreAfterMatch({
              mmrBefore: mmrUpdate.mmrBefore,
              visibleRankScoreBefore: visibleRankScoreBefore as number,
              outcome,
            });
      const progressAfter = rankedProgress(
        mmrUpdate.rankedGamesCompletedAfter,
        visibleRankScoreAfter,
      );

      await query(
        `
          /* ranked-duel:update-competitive-state */
          UPDATE competitive_ratings
          SET mmr = $3,
              ranked_games_completed = $4,
              visible_rank_score = $5,
              updated_at = $6
          WHERE user_id = $1 AND difficulty = $2
        `,
        [
          player.userId,
          input.difficulty,
          mmrUpdate.mmrAfter,
          mmrUpdate.rankedGamesCompletedAfter,
          visibleRankScoreAfter,
          input.endedAt,
        ],
      );
      await query(
        `
          /* ranked-duel:update-player */
          UPDATE game_players
          SET total_score = $2,
              result = $3,
              mmr_before = $4,
              mmr_after = $5
          WHERE id = $1
        `,
        [
          gamePlayerId,
          totalScore,
          outcome,
          mmrUpdate.mmrBefore,
          mmrUpdate.mmrAfter,
        ],
      );

      changes.push({
        userId: player.userId,
        outcome,
        progressBefore,
        progressAfter,
        lpChange:
          visibleRankScoreBefore === null || visibleRankScoreAfter === null
            ? null
            : visibleRankScoreAfter - visibleRankScoreBefore,
      });
    }

    const completed = await completeGame(query, input);
    if (completed.rowCount !== 1) {
      throw new Error("Ranked Duel was already finalized.");
    }

    return { status: "APPLIED", competitiveChanges: changes };
  });
}

function completeGame(
  query: RankedDuelQuery,
  input: RankedDuelFinalizationInput,
) {
  return query(
    `
      /* ranked-duel:complete-game */
      UPDATE games
      SET status = 'COMPLETED', end_reason = $2, ended_at = $3
      WHERE id = $1 AND status = 'ACTIVE'
    `,
    [
      input.runtimeGameId,
      input.completionReason === "ABANDON" ? "PLAYER_ABANDON" : "NORMAL",
      input.endedAt,
    ],
  );
}
