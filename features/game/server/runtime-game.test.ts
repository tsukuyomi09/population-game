import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGame, type RuntimeGameType } from "./runtime-game";
import {
  registeredRuntimePlayer,
  type GuestRuntimePlayer,
  type RuntimePlayer,
} from "../runtime-player";

const roundDurationMs = 60_000;
const startedAt = new Date("2026-01-01T00:00:00.000Z");

function guest(runtimePlayerId: string): GuestRuntimePlayer {
  return {
    kind: "guest",
    runtimePlayerId,
    guestSessionId: `${runtimePlayerId}-session`,
  };
}

function runtimeGame(
  players: RuntimePlayer[] = [registeredRuntimePlayer("user-1")],
  type: RuntimeGameType = "SINGLE",
) {
  let targetsGenerated = 0;
  const game = new RuntimeGame({
    runtimeGameId: "game-1",
    type,
    difficulty: "EASY",
    players,
    roundDurationMs,
    generateTarget: () => (++targetsGenerated) * 1_000,
  });
  game.start(startedAt);
  return { game, targetsGenerated: () => targetsGenerated };
}

function resolveManual(
  game: RuntimeGame,
  player: RuntimePlayer,
  roundNumber: number,
) {
  return game.resolvePlayer({
    player,
    roundNumber,
    submissionType: "MANUAL",
    calculatedPopulation: roundNumber * 1_000,
    resolvedAt: new Date(startedAt.getTime() + roundNumber * 1_000),
  });
}

test("duplicate submit is harmless", () => {
  const player = registeredRuntimePlayer("user-1");
  const { game } = runtimeGame([player]);

  const applied = resolveManual(game, player, 1);
  const duplicate = resolveManual(game, player, 1);

  assert.equal(applied.status, "APPLIED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.deepEqual(duplicate.resolution, applied.resolution);
  assert.equal(game.snapshot().totals[player.runtimePlayerId], 10_000);
});

test("manual submit and timeout race resolves a player once", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");

  const timeout = game.resolvePlayer({
    player: first,
    roundNumber: 1,
    submissionType: "TIMEOUT",
    calculatedPopulation: 1_000,
    resolvedAt: new Date(startedAt.getTime() + roundDurationMs),
  });
  const manual = game.resolvePlayer({
    player: first,
    roundNumber: 1,
    submissionType: "MANUAL",
    calculatedPopulation: 0,
    resolvedAt: new Date(startedAt.getTime() + 1_000),
  });

  assert.equal(timeout.status, "APPLIED");
  assert.equal(manual.status, "DUPLICATE");
  assert.equal(manual.resolution.submissionType, "TIMEOUT");
  assert.equal(game.snapshot().rounds[0].players[0].state, "RESOLVED");
});

test("five rounds advance and complete correctly", () => {
  const player = registeredRuntimePlayer("user-1");
  const { game } = runtimeGame([player]);

  for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
    const outcome = resolveManual(game, player, roundNumber);
    assert.equal(outcome.roundAdvanced, roundNumber < 5);
    assert.equal(outcome.gameFinalized, roundNumber === 5);
  }

  const snapshot = game.snapshot();
  assert.equal(snapshot.state, "COMPLETE");
  assert.equal(snapshot.rounds.length, 5);
  assert.ok(snapshot.rounds.every((round) => round.state === "RESOLVED"));
  assert.equal(snapshot.totals[player.runtimePlayerId], 50_000);
});

test("a resolved round advances only once", () => {
  const player = registeredRuntimePlayer("user-1");
  const { game, targetsGenerated } = runtimeGame([player]);

  const first = resolveManual(game, player, 1);
  const duplicate = resolveManual(game, player, 1);

  assert.equal(first.roundAdvanced, true);
  assert.equal(duplicate.roundAdvanced, false);
  assert.equal(targetsGenerated(), 2);
  assert.equal(game.snapshot().rounds.length, 2);
});

test("the game finalizes only once", () => {
  const player = registeredRuntimePlayer("user-1");
  const { game } = runtimeGame([player]);
  for (let roundNumber = 1; roundNumber < 5; roundNumber += 1) {
    resolveManual(game, player, roundNumber);
  }

  const final = resolveManual(game, player, 5);
  const completedAt = game.snapshot().completedAt;
  const duplicate = resolveManual(game, player, 5);

  assert.equal(final.gameFinalized, true);
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(duplicate.gameFinalized, false);
  assert.deepEqual(game.snapshot().completedAt, completedAt);
});
