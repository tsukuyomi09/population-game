import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeGame, type RuntimeGameType } from "./runtime-game";
import {
  registeredRuntimePlayer,
  type GuestRuntimePlayer,
  type RuntimePlayer,
} from "../runtime-player";

const roundDurationMs = 120_000;
const finalWindowMs = 10_000;
const resultPhaseDurationMs = 10_000;
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
    finalWindowMs,
    resultPhaseDurationMs,
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

test("Duel round starts with a 120 second authoritative deadline", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");

  const round = game.snapshot().currentRound;
  assert.ok(round);
  assert.equal(round.endsAt.getTime() - round.startedAt.getTime(), 120_000);
});

test("early manual submit caps the pending opponent to 10 seconds", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");
  const submittedAt = new Date(startedAt.getTime() + 20_000);

  const outcome = game.resolvePlayer({
    player: first,
    roundNumber: 1,
    submissionType: "MANUAL",
    calculatedPopulation: 1_000,
    resolvedAt: submittedAt,
  });

  assert.equal(outcome.deadlineUpdated, true);
  assert.equal(
    game.snapshot().currentRound?.endsAt.getTime(),
    submittedAt.getTime() + 10_000,
  );

  const duplicate = game.resolvePlayer({
    player: first,
    roundNumber: 1,
    submissionType: "MANUAL",
    calculatedPopulation: 0,
    resolvedAt: new Date(submittedAt.getTime() + 5_000),
  });
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(duplicate.deadlineUpdated, false);
  assert.equal(
    game.snapshot().currentRound?.endsAt.getTime(),
    submittedAt.getTime() + 10_000,
  );
});

test("early-submit cap never increases remaining time", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");
  const fiveSecondsRemaining = new Date(
    startedAt.getTime() + roundDurationMs - 5_000,
  );

  const applied = game.resolvePlayer({
    player: first,
    roundNumber: 1,
    submissionType: "MANUAL",
    calculatedPopulation: 1_000,
    resolvedAt: fiveSecondsRemaining,
  });
  const unchangedDeadline = game.snapshot().currentRound?.endsAt;
  const duplicate = game.resolvePlayer({
    player: first,
    roundNumber: 1,
    submissionType: "MANUAL",
    calculatedPopulation: 0,
    resolvedAt: new Date(fiveSecondsRemaining.getTime() + 1_000),
  });

  assert.equal(applied.deadlineUpdated, false);
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(duplicate.deadlineUpdated, false);
  assert.deepEqual(game.snapshot().currentRound?.endsAt, unchangedDeadline);
  assert.equal(unchangedDeadline?.getTime(), startedAt.getTime() + roundDurationMs);
});

function resolveDuelRound(
  game: RuntimeGame,
  first: RuntimePlayer,
  second: RuntimePlayer,
  roundNumber: number,
  submittedAt: Date,
) {
  game.resolvePlayer({
    player: first,
    roundNumber,
    submissionType: "MANUAL",
    calculatedPopulation: 1_000,
    resolvedAt: submittedAt,
  });
  return game.resolvePlayer({
    player: second,
    roundNumber,
    submissionType: "MANUAL",
    calculatedPopulation: 1_000,
    resolvedAt: new Date(submittedAt.getTime() + 1),
  });
}

test("both Duel submissions enter animation state without starting the result wait", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");

  const outcome = resolveDuelRound(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 1_000),
  );
  const snapshot = game.snapshot();

  assert.equal(outcome.roundAdvanced, false);
  assert.equal(outcome.roundResultStarted, true);
  assert.equal(snapshot.state, "ROUND_RESULT");
  assert.equal(snapshot.rounds.length, 1);
  assert.equal(snapshot.resultPhase?.state, "ANIMATING");
  assert.equal(snapshot.resultPhase?.startedAt, undefined);
  assert.equal(snapshot.resultPhase?.endsAt, undefined);
});

function completeDuelResultAnimations(
  game: RuntimeGame,
  first: RuntimePlayer,
  second: RuntimePlayer,
  roundNumber: number,
  firstCompletedAt: Date,
  secondCompletedAt: Date,
) {
  const firstCompletion = game.completeResultAnimation(
    first,
    roundNumber,
    firstCompletedAt,
  );
  const secondCompletion = game.completeResultAnimation(
    second,
    roundNumber,
    secondCompletedAt,
  );
  return { firstCompletion, secondCompletion };
}

test("ten-second result wait starts only after both animations complete", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");
  resolveDuelRound(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 1_000),
  );
  const firstCompletedAt = new Date(startedAt.getTime() + 10_000);
  const secondCompletedAt = new Date(startedAt.getTime() + 12_000);

  const firstCompletion = game.completeResultAnimation(
    first,
    1,
    firstCompletedAt,
  );
  assert.equal(firstCompletion.resultWaitStarted, false);
  assert.equal(game.snapshot().resultPhase?.state, "ANIMATING");
  assert.throws(
    () => game.readyForNextRound(first, 1, firstCompletedAt),
    /result wait has not started/,
  );

  const secondCompletion = game.completeResultAnimation(
    second,
    1,
    secondCompletedAt,
  );
  const resultPhase = game.snapshot().resultPhase;
  assert.equal(secondCompletion.resultWaitStarted, true);
  assert.equal(resultPhase?.state, "WAITING");
  assert.deepEqual(resultPhase?.startedAt, secondCompletedAt);
  assert.equal(
    resultPhase?.endsAt?.getTime(),
    secondCompletedAt.getTime() + resultPhaseDurationMs,
  );
});

test("result wait auto-advances exactly once after ten seconds", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game, targetsGenerated } = runtimeGame([first, second], "DUEL");
  resolveDuelRound(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 1_000),
  );
  completeDuelResultAnimations(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 10_000),
    new Date(startedAt.getTime() + 11_000),
  );
  const deadline = game.snapshot().resultPhase?.endsAt;
  assert.ok(deadline);

  const advanced = game.advanceResultPhase(1, deadline);
  const duplicate = game.advanceResultPhase(1, deadline);

  assert.equal(advanced.status, "APPLIED");
  assert.equal(advanced.nextRound?.roundNumber, 2);
  assert.equal(duplicate.status, "STALE");
  assert.equal(game.snapshot().rounds.length, 2);
  assert.equal(targetsGenerated(), 2);
});

test("one ready player waits; both ready players advance immediately", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");
  resolveDuelRound(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 1_000),
  );
  const readyAt = new Date(startedAt.getTime() + 12_000);
  completeDuelResultAnimations(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 10_000),
    new Date(startedAt.getTime() + 11_000),
  );

  const firstReady = game.readyForNextRound(first, 1, readyAt);
  assert.equal(firstReady.roundAdvanced, false);
  assert.equal(game.snapshot().state, "ROUND_RESULT");

  const secondReady = game.readyForNextRound(second, 1, readyAt);
  assert.equal(secondReady.roundAdvanced, true);
  assert.equal(secondReady.nextRound?.roundNumber, 2);
  assert.equal(game.snapshot().state, "ROUND_ACTIVE");
});

test("duplicate ready is harmless and stale ready cannot advance another round", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");
  resolveDuelRound(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 1_000),
  );
  const readyAt = new Date(startedAt.getTime() + 12_000);
  completeDuelResultAnimations(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 10_000),
    new Date(startedAt.getTime() + 11_000),
  );

  const applied = game.readyForNextRound(first, 1, readyAt);
  const duplicate = game.readyForNextRound(first, 1, readyAt);
  assert.equal(applied.status, "APPLIED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(duplicate.roundAdvanced, false);

  game.readyForNextRound(second, 1, readyAt);
  assert.throws(
    () => game.readyForNextRound(first, 1, readyAt),
    /result phase is not active/,
  );
  assert.equal(game.snapshot().currentRound?.roundNumber, 2);
});

test("duplicate and stale result-animation completion signals are harmless", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");
  resolveDuelRound(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 1_000),
  );
  const completedAt = new Date(startedAt.getTime() + 10_000);

  const applied = game.completeResultAnimation(first, 1, completedAt);
  const duplicate = game.completeResultAnimation(first, 1, completedAt);
  assert.equal(applied.status, "APPLIED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(duplicate.resultWaitStarted, false);

  game.completeResultAnimation(second, 1, completedAt);
  const deadline = game.snapshot().resultPhase?.endsAt;
  assert.ok(deadline);
  game.advanceResultPhase(1, deadline);

  const stale = game.completeResultAnimation(first, 1, completedAt);
  assert.equal(stale.status, "STALE");
  assert.equal(stale.resultWaitStarted, false);
  assert.equal(game.snapshot().currentRound?.roundNumber, 2);
});

test("final Duel round finalizes without a result phase or round six", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");

  for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
    const activeRound = game.snapshot().currentRound;
    assert.equal(activeRound?.roundNumber, roundNumber);
    const submittedAt = new Date(activeRound.startedAt.getTime() + 1_000);
    const outcome = resolveDuelRound(
      game,
      first,
      second,
      roundNumber,
      submittedAt,
    );

    if (roundNumber < 5) {
      completeDuelResultAnimations(
        game,
        first,
        second,
        roundNumber,
        new Date(submittedAt.getTime() + 2_000),
        new Date(submittedAt.getTime() + 3_000),
      );
      const resultDeadline = game.snapshot().resultPhase?.endsAt;
      assert.ok(resultDeadline);
      game.advanceResultPhase(roundNumber, resultDeadline);
    } else {
      assert.equal(outcome.gameFinalized, true);
      assert.equal(outcome.roundResultStarted, false);
    }
  }

  const snapshot = game.snapshot();
  assert.equal(snapshot.state, "COMPLETE");
  assert.equal(snapshot.rounds.length, 5);
  assert.equal(snapshot.resultPhase, undefined);
  assert.equal(snapshot.currentRound, undefined);
});

test("abandon during an active round is terminal and idempotent", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game, targetsGenerated } = runtimeGame([first, second], "DUEL");
  const abandonedAt = new Date(startedAt.getTime() + 1_000);

  const applied = game.abandon(first, abandonedAt);
  const snapshotAfterAbandon = game.snapshot();
  const duplicate = game.abandon(first, abandonedAt);

  assert.equal(applied.status, "APPLIED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(snapshotAfterAbandon.state, "COMPLETE");
  assert.equal(
    snapshotAfterAbandon.abandonment?.abandonedRuntimePlayerId,
    first.runtimePlayerId,
  );
  assert.equal(
    snapshotAfterAbandon.abandonment?.winnerRuntimePlayerId,
    second.runtimePlayerId,
  );
  assert.equal(snapshotAfterAbandon.rounds.length, 1);
  assert.equal(snapshotAfterAbandon.rounds[0]?.state, "ACTIVE");
  assert.equal(
    snapshotAfterAbandon.rounds[0]?.players.some(
      (state) => state.resolution !== undefined,
    ),
    false,
  );
  assert.equal(snapshotAfterAbandon.currentRound, undefined);
  assert.equal(snapshotAfterAbandon.resultPhase, undefined);
  assert.equal(targetsGenerated(), 1);
  assert.deepEqual(game.snapshot(), snapshotAfterAbandon);
});

test("abandon during result animation preserves the resolved round", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game } = runtimeGame([first, second], "DUEL");
  resolveDuelRound(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 1_000),
  );

  const applied = game.abandon(first, new Date(startedAt.getTime() + 5_000));
  const snapshot = game.snapshot();

  assert.equal(applied.status, "APPLIED");
  assert.equal(snapshot.state, "COMPLETE");
  assert.equal(snapshot.resultPhase, undefined);
  assert.equal(snapshot.rounds.length, 1);
  assert.equal(snapshot.rounds[0]?.state, "RESOLVED");
  assert.equal(
    snapshot.rounds[0]?.players.filter((state) => state.resolution).length,
    2,
  );
});

test("abandon during result waiting prevents timer and ready advancement", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game, targetsGenerated } = runtimeGame([first, second], "DUEL");
  resolveDuelRound(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 1_000),
  );
  completeDuelResultAnimations(
    game,
    first,
    second,
    1,
    new Date(startedAt.getTime() + 4_000),
    new Date(startedAt.getTime() + 5_000),
  );
  const resultDeadline = game.snapshot().resultPhase?.endsAt;
  assert.ok(resultDeadline);
  game.readyForNextRound(first, 1, new Date(startedAt.getTime() + 6_000));

  game.abandon(second, new Date(startedAt.getTime() + 7_000));
  const timedAdvance = game.advanceResultPhase(1, resultDeadline);

  assert.equal(timedAdvance.status, "STALE");
  assert.throws(
    () =>
      game.readyForNextRound(
        second,
        1,
        new Date(startedAt.getTime() + 7_001),
      ),
    /result phase is not active/,
  );
  assert.equal(game.snapshot().rounds.length, 1);
  assert.equal(targetsGenerated(), 1);
});

test("terminal abandon rejects stale mutations without fabricating future rounds", () => {
  const first = guest("guest-1");
  const second = guest("guest-2");
  const { game, targetsGenerated } = runtimeGame([first, second], "DUEL");
  const abandonedAt = new Date(startedAt.getTime() + 1_000);
  game.abandon(first, abandonedAt);
  const terminalSnapshot = game.snapshot();

  assert.throws(
    () =>
      game.resolvePlayer({
        player: second,
        roundNumber: 1,
        submissionType: "MANUAL",
        calculatedPopulation: 1_000,
        resolvedAt: new Date(abandonedAt.getTime() + 1),
      }),
    /round is not active/,
  );
  assert.throws(
    () => game.readyForNextRound(second, 1, abandonedAt),
    /result phase is not active/,
  );
  assert.equal(
    game.completeResultAnimation(second, 1, abandonedAt).status,
    "STALE",
  );
  assert.deepEqual(game.snapshot(), terminalSnapshot);
  assert.equal(game.snapshot().rounds.length, 1);
  assert.equal(targetsGenerated(), 1);
});
