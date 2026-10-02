import assert from "node:assert/strict";
import test from "node:test";
import type { GuestRuntimePlayer, RegisteredRuntimePlayer } from "../../game/runtime-player";
import {
  finalizeRankedDuel,
  RankedDuelEligibilityError,
  type RankedDuelFinalizationInput,
  type RankedDuelQuery,
  type RankedDuelTransaction,
} from "./ranked-duel-finalization";

function registered(id: string): RegisteredRuntimePlayer {
  return {
    kind: "registered",
    runtimePlayerId: `runtime-${id}`,
    userId: id,
  };
}

function guest(id: string): GuestRuntimePlayer {
  return {
    kind: "guest",
    runtimePlayerId: `runtime-${id}`,
    guestSessionId: id,
  };
}

type StoredGame = {
  type: "DUEL";
  difficulty: "EASY" | "REAL";
  rated: boolean;
  status: "ACTIVE" | "COMPLETED";
  endReason?: "NORMAL" | "PLAYER_ABANDON" | "DISCONNECT_FORFEIT";
};

type StoredPlayer = {
  id: string;
  gameId: string;
  userId: string;
  totalScore?: number;
  result?: "WIN" | "LOSS" | "DRAW";
  mmrBefore?: number;
  mmrAfter?: number;
};

type StoredCompetitiveState = {
  mmr: number;
  rankedGamesCompleted: number;
  visibleRankScore: number | null;
};

class FakeRankedDatabase {
  readonly games = new Map<string, StoredGame>();
  readonly players = new Map<string, StoredPlayer>();
  readonly rounds = new Map<
    string,
    {
      id: string;
      gameId: string;
      roundNumber: number;
      targetPopulation: number;
    }
  >();
  readonly roundResults = new Map<string, true>();
  readonly competitiveStates = new Map<string, StoredCompetitiveState>();
  transactionCalls = 0;
  competitiveStateUpdateCalls = 0;

  readonly transaction: RankedDuelTransaction = async (work) => {
    this.transactionCalls += 1;
    return work(this.query);
  };

  competitiveState(userId: string, difficulty: "EASY" | "REAL") {
    return this.competitiveStates.get(`${difficulty}:${userId}`);
  }

  setCompetitiveState(
    userId: string,
    difficulty: "EASY" | "REAL",
    state: Partial<StoredCompetitiveState> & Pick<StoredCompetitiveState, "mmr">,
  ) {
    this.competitiveStates.set(`${difficulty}:${userId}`, {
      mmr: state.mmr,
      rankedGamesCompleted: state.rankedGamesCompleted ?? 0,
      visibleRankScore: state.visibleRankScore ?? null,
    });
  }

  player(gameId: string, userId: string) {
    return this.players.get(`${gameId}:${userId}`);
  }

  private readonly query: RankedDuelQuery = async (text, values = []) => {
    if (text.includes("ranked-duel:insert-game")) {
      const [gameId, difficulty, rated] = values as [
        string,
        "EASY" | "REAL",
        boolean,
      ];
      if (!this.games.has(gameId)) {
        this.games.set(gameId, {
          type: "DUEL",
          difficulty,
          rated,
          status: "ACTIVE",
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("ranked-duel:lock-game")) {
      const game = this.games.get(values[0] as string);
      return { rows: game ? [{ ...game }] : [], rowCount: game ? 1 : 0 };
    }

    if (text.includes("ranked-duel:insert-player")) {
      const [gameId, userId] = values as [string, string];
      const key = `${gameId}:${userId}`;
      if (!this.players.has(key)) {
        this.players.set(key, {
          id: `game-player-${gameId}-${userId}`,
          gameId,
          userId,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("ranked-duel:lock-players")) {
      const gameId = values[0] as string;
      const rows = [...this.players.values()]
        .filter((player) => player.gameId === gameId)
        .sort((left, right) => left.userId.localeCompare(right.userId))
        .map(({ id, userId }) => ({ id, userId }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes("ranked-duel:insert-round */")) {
      const [gameId, roundNumber, targetPopulation] = values as [
        string,
        number,
        number,
      ];
      const key = `${gameId}:${roundNumber}`;
      if (!this.rounds.has(key)) {
        this.rounds.set(key, {
          id: `round-${gameId}-${roundNumber}`,
          gameId,
          roundNumber,
          targetPopulation,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("ranked-duel:lock-rounds")) {
      const gameId = values[0] as string;
      const rows = [...this.rounds.values()]
        .filter((round) => round.gameId === gameId)
        .sort((left, right) => left.roundNumber - right.roundNumber)
        .map(({ id, roundNumber, targetPopulation }) => ({
          id,
          roundNumber,
          targetPopulation,
        }));
      return { rows, rowCount: rows.length };
    }

    if (text.includes("ranked-duel:insert-round-result")) {
      const [roundId, gamePlayerId] = values as [string, string];
      this.roundResults.set(`${roundId}:${gamePlayerId}`, true);
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("ranked-duel:update-unrated-player")) {
      const [id, totalScore, result] = values as [
        string,
        number,
        "WIN" | "LOSS" | "DRAW",
      ];
      const player = [...this.players.values()].find(
        (candidate) => candidate.id === id,
      );
      assert.ok(player);
      Object.assign(player, { totalScore, result });
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("ranked-duel:insert-competitive-state")) {
      const [userId, difficulty, mmr] = values as [
        string,
        "EASY" | "REAL",
        number,
      ];
      const key = `${difficulty}:${userId}`;
      if (!this.competitiveStates.has(key)) {
        this.competitiveStates.set(key, {
          mmr,
          rankedGamesCompleted: 0,
          visibleRankScore: null,
        });
      }
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("ranked-duel:lock-competitive-state")) {
      const [difficulty, userIds] = values as [
        "EASY" | "REAL",
        string[],
      ];
      const rows = [...userIds]
        .sort((left, right) => left.localeCompare(right))
        .flatMap((userId) => {
          const state = this.competitiveState(userId, difficulty);
          return state === undefined ? [] : [{ userId, ...state }];
        });
      return { rows, rowCount: rows.length };
    }

    if (text.includes("ranked-duel:update-competitive-state")) {
      const [
        userId,
        difficulty,
        mmr,
        rankedGamesCompleted,
        visibleRankScore,
      ] = values as [
        string,
        "EASY" | "REAL",
        number,
        number,
        number | null,
      ];
      this.setCompetitiveState(userId, difficulty, {
        mmr,
        rankedGamesCompleted,
        visibleRankScore,
      });
      this.competitiveStateUpdateCalls += 1;
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("ranked-duel:update-player")) {
      const [id, totalScore, result, mmrBefore, mmrAfter] = values as [
        string,
        number,
        "WIN" | "LOSS" | "DRAW",
        number,
        number,
      ];
      const player = [...this.players.values()].find(
        (candidate) => candidate.id === id,
      );
      assert.ok(player);
      Object.assign(player, {
        totalScore,
        result,
        mmrBefore,
        mmrAfter,
      });
      return { rows: [], rowCount: 1 };
    }

    if (text.includes("ranked-duel:complete-game")) {
      const [gameId, endReason] = values as [
        string,
        "NORMAL" | "PLAYER_ABANDON" | "DISCONNECT_FORFEIT",
      ];
      const game = this.games.get(gameId);
      if (!game || game.status !== "ACTIVE") {
        return { rows: [], rowCount: 0 };
      }
      game.status = "COMPLETED";
      game.endReason = endReason;
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected query: ${text}`);
  };
}

function finalization(
  overrides: Partial<RankedDuelFinalizationInput> = {},
): RankedDuelFinalizationInput {
  const first = registered("user-a");
  const second = registered("user-b");
  const resolvedAt = new Date("2026-01-01T00:02:00.000Z");
  return {
    runtimeGameId: "00000000-0000-4000-8000-000000000001",
    difficulty: "EASY",
    rated: true,
    players: [
      { player: first, totalScore: 40_000 },
      { player: second, totalScore: 30_000 },
    ],
    rounds: [
      {
        roundNumber: 1,
        targetPopulation: 1_000,
        startedAt: new Date("2026-01-01T00:00:00.000Z"),
        endsAt: resolvedAt,
        state: "RESOLVED",
        players: [
          {
            player: first,
            state: "RESOLVED",
            resolution: {
              runtimePlayerId: first.runtimePlayerId,
              submissionType: "MANUAL",
              calculatedPopulation: 1_000,
              score: 10_000,
              resolvedAt,
            },
          },
          {
            player: second,
            state: "RESOLVED",
            resolution: {
              runtimePlayerId: second.runtimePlayerId,
              submissionType: "MANUAL",
              calculatedPopulation: 900,
              score: 9_000,
              resolvedAt,
            },
          },
        ],
      },
    ],
    completionReason: "ROUNDS_COMPLETE",
    startedAt: new Date("2026-01-01T00:00:00.000Z"),
    endedAt: new Date("2026-01-01T00:10:00.000Z"),
    ...overrides,
  };
}

test("applies equal-MMR WIN and LOSS once with lazy state and snapshots", async () => {
  const database = new FakeRankedDatabase();
  const input = finalization();
  const result = await finalizeRankedDuel(input, database.transaction);

  assert.equal(result.status, "APPLIED");
  assert.deepEqual(database.competitiveState("user-a", "EASY"), {
    mmr: 1_024,
    rankedGamesCompleted: 1,
    visibleRankScore: null,
  });
  assert.deepEqual(database.competitiveState("user-b", "EASY"), {
    mmr: 976,
    rankedGamesCompleted: 1,
    visibleRankScore: null,
  });
  assert.deepEqual(database.player(input.runtimeGameId, "user-a"), {
    id: `game-player-${input.runtimeGameId}-user-a`,
    gameId: input.runtimeGameId,
    userId: "user-a",
    totalScore: 40_000,
    result: "WIN",
    mmrBefore: 1_000,
    mmrAfter: 1_024,
  });
  assert.equal(database.player(input.runtimeGameId, "user-b")?.result, "LOSS");
});

test("a draw moves unequal MMRs toward each other", async () => {
  const database = new FakeRankedDatabase();
  database.setCompetitiveState("user-a", "EASY", {
    mmr: 1_120,
    rankedGamesCompleted: 10,
    visibleRankScore: 500,
  });
  database.setCompetitiveState("user-b", "EASY", {
    mmr: 940,
    rankedGamesCompleted: 10,
    visibleRankScore: 300,
  });
  const input = finalization({
    players: [
      { player: registered("user-a"), totalScore: 35_000 },
      { player: registered("user-b"), totalScore: 35_000 },
    ],
  });

  await finalizeRankedDuel(input, database.transaction);

  assert.equal(database.competitiveState("user-a", "EASY")?.mmr, 1_112);
  assert.equal(database.competitiveState("user-b", "EASY")?.mmr, 948);
  assert.equal(database.player(input.runtimeGameId, "user-a")?.result, "DRAW");
  assert.equal(database.player(input.runtimeGameId, "user-b")?.mmrAfter, 948);
  assert.equal(database.competitiveState("user-a", "EASY")?.visibleRankScore, 500);
  assert.equal(database.competitiveState("user-b", "EASY")?.visibleRankScore, 300);
});

test("LOSS respects the 400 MMR floor", async () => {
  const database = new FakeRankedDatabase();
  database.setCompetitiveState("user-b", "EASY", { mmr: 400 });
  const input = finalization();

  await finalizeRankedDuel(input, database.transaction);

  assert.equal(database.competitiveState("user-b", "EASY")?.mmr, 400);
  assert.equal(database.player(input.runtimeGameId, "user-b")?.mmrBefore, 400);
  assert.equal(database.player(input.runtimeGameId, "user-b")?.mmrAfter, 400);
});

test("REAL finalization does not change EASY competitive state", async () => {
  const database = new FakeRankedDatabase();
  database.setCompetitiveState("user-a", "EASY", { mmr: 1_300 });
  database.setCompetitiveState("user-b", "EASY", { mmr: 700 });

  await finalizeRankedDuel(
    finalization({ difficulty: "REAL" }),
    database.transaction,
  );

  assert.equal(database.competitiveState("user-a", "EASY")?.mmr, 1_300);
  assert.equal(database.competitiveState("user-b", "EASY")?.mmr, 700);
  assert.equal(database.competitiveState("user-a", "REAL")?.mmr, 1_024);
  assert.equal(database.competitiveState("user-b", "REAL")?.mmr, 976);
});

test("game 10 uses K48, advances placement, and game 11 uses K32", async () => {
  const database = new FakeRankedDatabase();
  database.setCompetitiveState("user-a", "EASY", {
    mmr: 1_000,
    rankedGamesCompleted: 9,
  });
  database.setCompetitiveState("user-b", "EASY", {
    mmr: 1_000,
    rankedGamesCompleted: 10,
    visibleRankScore: 400,
  });

  const result = await finalizeRankedDuel(finalization(), database.transaction);

  assert.deepEqual(database.competitiveState("user-a", "EASY"), {
    mmr: 1_024,
    rankedGamesCompleted: 10,
    visibleRankScore: 474,
  });
  assert.deepEqual(database.competitiveState("user-b", "EASY"), {
    mmr: 984,
    rankedGamesCompleted: 10,
    visibleRankScore: 384,
  });
  assert.equal(result.status, "APPLIED");
  if (result.status !== "APPLIED") throw new Error("Expected applied result.");
  const revealed = result.competitiveChanges.find(
    ({ userId }) => userId === "user-a",
  );
  assert.deepEqual(revealed?.progressBefore, {
    status: "UNRANKED",
    rankedGamesCompleted: 9,
    placementsRequired: 10,
  });
  assert.deepEqual(revealed?.progressAfter, {
    status: "RANKED",
    rankedGamesCompleted: 10,
    tier: "SILVER",
    division: "II",
    label: "Silver II",
    lp: 74,
  });
  assert.equal(revealed?.lpChange, null);
  assert.doesNotMatch(JSON.stringify(result), /mmr/i);
});

test("post-placement LP alignment uses pre-match MMR", async () => {
  const database = new FakeRankedDatabase();
  database.setCompetitiveState("user-a", "EASY", {
    mmr: 1_400,
    rankedGamesCompleted: 10,
    visibleRankScore: 750,
  });
  database.setCompetitiveState("user-b", "EASY", {
    mmr: 1_000,
    rankedGamesCompleted: 10,
    visibleRankScore: 400,
  });

  const result = await finalizeRankedDuel(finalization(), database.transaction);

  assert.equal(database.competitiveState("user-a", "EASY")?.mmr, 1_403);
  assert.equal(database.competitiveState("user-a", "EASY")?.visibleRankScore, 766);
  assert.equal(database.competitiveState("user-b", "EASY")?.visibleRankScore, 384);
  assert.equal(result.status, "APPLIED");
  if (result.status !== "APPLIED") throw new Error("Expected applied result.");
  assert.equal(
    result.competitiveChanges.find(({ userId }) => userId === "user-a")
      ?.lpChange,
    16,
  );
  assert.equal(
    result.competitiveChanges.find(({ userId }) => userId === "user-b")
      ?.lpChange,
    -16,
  );
});

test("duplicate normal completion cannot apply MMR twice", async () => {
  const database = new FakeRankedDatabase();
  const input = finalization();

  assert.equal(
    (await finalizeRankedDuel(input, database.transaction)).status,
    "APPLIED",
  );
  assert.equal(
    (await finalizeRankedDuel(input, database.transaction)).status,
    "DUPLICATE",
  );
  assert.equal(database.competitiveState("user-a", "EASY")?.mmr, 1_024);
  assert.equal(database.competitiveState("user-b", "EASY")?.mmr, 976);
  assert.equal(database.competitiveStateUpdateCalls, 2);
});

test("duplicate abandon cannot apply MMR or placement twice", async () => {
  const database = new FakeRankedDatabase();
  const input = finalization({
    completionReason: "ABANDON",
    abandonedRuntimePlayerId: "runtime-user-a",
  });

  assert.equal(
    (await finalizeRankedDuel(input, database.transaction)).status,
    "APPLIED",
  );
  assert.equal(
    (await finalizeRankedDuel(input, database.transaction)).status,
    "DUPLICATE",
  );
  assert.deepEqual(database.competitiveState("user-a", "EASY"), {
    mmr: 976,
    rankedGamesCompleted: 1,
    visibleRankScore: null,
  });
  assert.equal(database.competitiveState("user-b", "EASY")?.mmr, 1_024);
  assert.equal(database.games.get(input.runtimeGameId)?.endReason, "PLAYER_ABANDON");
  assert.equal(database.competitiveStateUpdateCalls, 2);
});

test("disconnect forfeit applies one normal WIN/LOSS competitive result", async () => {
  const database = new FakeRankedDatabase();
  const input = finalization({
    completionReason: "DISCONNECT_FORFEIT",
    forfeitedRuntimePlayerId: "runtime-user-b",
  });

  const result = await finalizeRankedDuel(input, database.transaction);

  assert.equal(result.status, "APPLIED");
  assert.equal(database.player(input.runtimeGameId, "user-a")?.result, "WIN");
  assert.equal(database.player(input.runtimeGameId, "user-b")?.result, "LOSS");
  assert.equal(database.competitiveState("user-a", "EASY")?.rankedGamesCompleted, 1);
  assert.equal(database.competitiveState("user-b", "EASY")?.rankedGamesCompleted, 1);
  assert.equal(
    database.games.get(input.runtimeGameId)?.endReason,
    "DISCONNECT_FORFEIT",
  );
});

test("an all-registered unrated Duel persists without competitive changes", async () => {
  const database = new FakeRankedDatabase();
  const input = finalization({ rated: false });
  const result = await finalizeRankedDuel(
    input,
    database.transaction,
  );

  assert.deepEqual(result, { status: "APPLIED", competitiveChanges: [] });
  assert.equal(database.transactionCalls, 1);
  assert.equal(database.competitiveStates.size, 0);
  assert.equal(database.games.get(input.runtimeGameId)?.status, "COMPLETED");
  assert.equal(database.player(input.runtimeGameId, "user-a")?.result, "WIN");
  assert.equal(database.rounds.size, 1);
  assert.equal(database.roundResults.size, 2);
});

test("an unrated guest-containing Duel remains runtime-only", async () => {
  const database = new FakeRankedDatabase();
  const result = await finalizeRankedDuel(
    finalization({
      rated: false,
      players: [
        { player: registered("user-a"), totalScore: 40_000 },
        { player: guest("guest-b"), totalScore: 30_000 },
      ],
    }),
    database.transaction,
  );

  assert.deepEqual(result, { status: "SKIPPED_RUNTIME_ONLY" });
  assert.equal(database.transactionCalls, 0);
  assert.equal(database.games.size, 0);
});

test("a rated guest-containing Duel is rejected before persistence", async () => {
  const database = new FakeRankedDatabase();
  const input = finalization({
    players: [
      { player: registered("user-a"), totalScore: 40_000 },
      { player: guest("guest-b"), totalScore: 30_000 },
    ],
  });

  await assert.rejects(
    finalizeRankedDuel(input, database.transaction),
    RankedDuelEligibilityError,
  );
  assert.equal(database.transactionCalls, 0);
  assert.equal(database.competitiveStates.size, 0);
  assert.equal(database.games.size, 0);
});
