import assert from "node:assert/strict";
import test from "node:test";
import { registeredRuntimePlayer, type GuestRuntimePlayer } from "../runtime-player";
import type { GameDifficulty } from "../single-player";
import {
  SingleGameService,
  type SingleGamePersistence,
} from "./single-game-service";

class FakePersistence implements SingleGamePersistence {
  readonly games: Array<{ difficulty: GameDifficulty }> = [];
  readonly rounds: Array<{ gameId: string; roundNumber: number }> = [];
  readonly results: Array<{
    gameId: string;
    roundNumber: number;
    calculatedPopulation: number;
    score: number;
    submissionType: "MANUAL" | "TIMEOUT";
    completeGame: boolean;
  }> = [];
  readonly abandons: string[] = [];
  private readonly totals = new Map<string, number>();
  private sequence = 0;

  async createGame(input: Parameters<SingleGamePersistence["createGame"]>[0]) {
    const gameId = `game-${++this.sequence}`;
    const gamePlayerId = `player-${this.sequence}`;
    this.games.push({ difficulty: input.difficulty });
    this.rounds.push({ gameId, roundNumber: input.roundNumber });
    this.totals.set(gamePlayerId, 0);
    return { gameId, gamePlayerId, roundId: `round-${this.sequence}-1` };
  }

  async createRound(input: Parameters<SingleGamePersistence["createRound"]>[0]) {
    this.rounds.push({ gameId: input.gameId, roundNumber: input.roundNumber });
    return { roundId: `round-${input.gameId}-${input.roundNumber}` };
  }

  async resolveRound(input: Parameters<SingleGamePersistence["resolveRound"]>[0]) {
    this.results.push({
      gameId: input.gameId,
      roundNumber: input.roundNumber,
      calculatedPopulation: input.calculatedPopulation,
      score: input.score,
      submissionType: input.submissionType,
      completeGame: input.completeGame,
    });
    const totalScore = (this.totals.get(input.gamePlayerId) ?? 0) + input.score;
    this.totals.set(input.gamePlayerId, totalScore);
    return { totalScore };
  }

  async abandonGame(input: Parameters<SingleGamePersistence["abandonGame"]>[0]) {
    this.abandons.push(input.gameId);
    return { totalScore: this.totals.get(input.gamePlayerId) ?? 0 };
  }

  get writeCount() {
    return (
      this.games.length +
      this.rounds.length +
      this.results.length +
      this.abandons.length
    );
  }
}

function service(persistence: FakePersistence) {
  let target = 900;
  let runtimeId = 0;

  return new SingleGameService(
    persistence,
    () => (target += 100),
    () => `runtime-${++runtimeId}`,
    () => new Date("2026-01-01T00:00:00.000Z"),
  );
}

test("persists and completes exactly five registered Single rounds", async () => {
  const persistence = new FakePersistence();
  const games = service(persistence);
  const player = registeredRuntimePlayer("user-1");
  let round = await games.startGame(player, "EASY");

  for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
    const result = await games.resolveRound(
      player,
      round.runtimeGameId,
      roundNumber === 2 ? "TIMEOUT" : "MANUAL",
      async () => round.target,
    );

    assert.equal(result.totalScore, roundNumber * 10_000);
    assert.equal(result.complete, roundNumber === 5);
    if (roundNumber < 5) {
      round = await games.startNextRound(player, round.runtimeGameId);
    }
  }

  assert.equal(persistence.games.length, 1);
  assert.deepEqual(
    persistence.rounds.map((item) => item.roundNumber),
    [1, 2, 3, 4, 5],
  );
  assert.equal(persistence.results.length, 5);
  assert.deepEqual(
    persistence.results.map((result) => result.calculatedPopulation),
    [1_000, 1_100, 1_200, 1_300, 1_400],
  );
  assert.ok(persistence.results.every((result) => result.score === 10_000));
  assert.equal(persistence.results[1].submissionType, "TIMEOUT");
  assert.equal(persistence.results[4].completeGame, true);
});

test("registered abandon finalizes without creating future rounds", async () => {
  const persistence = new FakePersistence();
  const games = service(persistence);
  const player = registeredRuntimePlayer("user-2");
  const firstRound = await games.startGame(player, "REAL");

  await games.resolveRound(
    player,
    firstRound.runtimeGameId,
    "MANUAL",
    async () => firstRound.target,
  );
  await games.startNextRound(player, firstRound.runtimeGameId);
  const abandoned = await games.abandonGame(player, firstRound.runtimeGameId);

  assert.equal(abandoned.totalScore, 10_000);
  assert.equal(persistence.abandons.length, 1);
  assert.deepEqual(
    persistence.rounds.map((item) => item.roundNumber),
    [1, 2],
  );
  await assert.rejects(
    games.startNextRound(player, firstRound.runtimeGameId),
    /already finished/,
  );
});

test("guest Single creates no persistent game history", async () => {
  const persistence = new FakePersistence();
  const games = service(persistence);
  const player: GuestRuntimePlayer = {
    kind: "guest",
    runtimePlayerId: "guest-runtime",
    guestSessionId: "guest-session",
  };
  const round = await games.startGame(player, "EASY");

  await games.resolveRound(
    player,
    round.runtimeGameId,
    "MANUAL",
    async () => round.target,
  );
  await games.startNextRound(player, round.runtimeGameId);
  await games.abandonGame(player, round.runtimeGameId);

  assert.equal(persistence.writeCount, 0);
});

test("persists EASY and REAL independently on registered game creation", async () => {
  const persistence = new FakePersistence();
  const games = service(persistence);
  const player = registeredRuntimePlayer("user-3");

  await games.startGame(player, "EASY");
  await games.startGame(player, "REAL");

  assert.deepEqual(
    persistence.games.map((game) => game.difficulty),
    ["EASY", "REAL"],
  );
});
