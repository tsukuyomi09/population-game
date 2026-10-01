import assert from "node:assert/strict";
import test from "node:test";
import type { PopulationShape } from "../../population/types";
import type { GuestRuntimePlayer } from "../runtime-player";
import {
  DirectDuelService,
  type DirectDuelEvent,
} from "./direct-duel-service";

function guest(id: string): GuestRuntimePlayer {
  return {
    kind: "guest",
    runtimePlayerId: id,
    guestSessionId: `${id}-session`,
  };
}

function shape(population: number): PopulationShape {
  return {
    id: population,
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [0, 0],
          [1, 0],
          [0, 1],
          [0, 0],
        ],
      ],
    },
  };
}

class FakeRuntime {
  now = new Date("2026-01-01T00:00:00.000Z");
  private timers: Array<{ callback: () => void; cancelled: boolean }> = [];

  schedule = (callback: () => void) => {
    const timer = { callback, cancelled: false };
    this.timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };

  moveTo(value: string | Date) {
    this.now = new Date(value);
  }

  fireRoundDeadline(round: { endsAt: string }) {
    this.fireNextTimerAt(round.endsAt);
  }

  fireNextTimerAt(value: string | Date) {
    this.moveTo(value);
    const timer = this.timers.find((candidate) => !candidate.cancelled);
    assert.ok(timer);
    timer.cancelled = true;
    timer.callback();
  }

  activeTimerCount() {
    return this.timers.filter((timer) => !timer.cancelled).length;
  }
}

function service(runtime: FakeRuntime) {
  return new DirectDuelService({
    generateDuelId: () => "duel-1",
    generateTarget: () => 1_000,
    roundDurationMs: 120_000,
    finalWindowMs: 10_000,
    resultPhaseDurationMs: 10_000,
    now: () => new Date(runtime.now),
    schedule: runtime.schedule,
  });
}

async function population(shapes: PopulationShape[]) {
  return Number(shapes[0]?.id ?? 0);
}

test("direct Duel streams five authoritative rounds and one final result", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const firstEvents: DirectDuelEvent[] = [];
  const secondEvents: DirectDuelEvent[] = [];
  const created = duels.create(first, "EASY");
  duels.subscribe(created.duelId, first, (event) => firstEvents.push(event));
  const joined = duels.join(second, created.duelId);
  duels.subscribe(created.duelId, second, (event) => secondEvents.push(event));

  const firstRound = firstEvents.find(
    (event) => event.type === "round_started",
  )?.round;
  const secondRound = secondEvents.find(
    (event) => event.type === "round_started",
  )?.round;
  assert.ok(firstRound);
  assert.deepEqual(firstRound, joined.round);
  assert.deepEqual(secondRound, firstRound);
  assert.equal(firstRound.target, 1_000);
  assert.equal(
    new Date(firstRound.endsAt).getTime() -
      new Date(firstRound.startedAt).getTime(),
    120_000,
  );
  assert.throws(() => duels.join(guest("player-3"), created.duelId), /full/);

  runtime.fireRoundDeadline(firstRound);
  assert.equal(
    firstEvents.filter((event) => event.type === "timeout_submission_requested")
      .length,
    1,
  );
  assert.equal(
    secondEvents.filter((event) => event.type === "timeout_submission_requested")
      .length,
    1,
  );

  await duels.submit(
    created.duelId,
    first,
    1,
    "TIMEOUT",
    [shape(1_000)],
    population,
  );
  assert.equal(
    secondEvents.filter((event) => event.type === "opponent_submitted").length,
    1,
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "round_resolved").length,
    0,
  );

  await duels.submit(
    created.duelId,
    second,
    1,
    "TIMEOUT",
    [shape(0)],
    population,
  );
  const eventCountBeforeDuplicate = firstEvents.length + secondEvents.length;
  const duplicate = await duels.submit(
    created.duelId,
    first,
    1,
    "TIMEOUT",
    [shape(0)],
    population,
  );
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(firstEvents.length + secondEvents.length, eventCountBeforeDuplicate);
  assert.equal(
    firstEvents.filter((event) => event.type === "round_started").length,
    1,
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "result_phase_started").length,
    0,
  );
  const firstAnimationComplete = duels.completeResultAnimation(
    created.duelId,
    first,
    1,
  );
  assert.equal(firstAnimationComplete.resultWaitStarted, false);
  assert.equal(
    firstEvents.filter((event) => event.type === "result_phase_started").length,
    0,
  );
  const secondAnimationComplete = duels.completeResultAnimation(
    created.duelId,
    second,
    1,
  );
  assert.equal(secondAnimationComplete.resultWaitStarted, true);
  const firstResultPhase = [...firstEvents]
    .reverse()
    .find((event) => event.type === "result_phase_started")?.resultPhase;
  assert.ok(firstResultPhase);
  assert.equal(
    new Date(firstResultPhase.endsAt).getTime() -
      new Date(firstResultPhase.startedAt).getTime(),
    10_000,
  );
  runtime.fireNextTimerAt(firstResultPhase.endsAt);

  for (let roundNumber = 2; roundNumber <= 5; roundNumber += 1) {
    const currentRound = [...firstEvents]
      .reverse()
      .find((event) => event.type === "round_started")?.round;
    assert.equal(currentRound?.roundNumber, roundNumber);
    runtime.moveTo(new Date(new Date(currentRound.startedAt).getTime() + 1_000));

    await duels.submit(
      created.duelId,
      first,
      roundNumber,
      "MANUAL",
      [shape(1_000)],
      population,
    );
    await duels.submit(
      created.duelId,
      second,
      roundNumber,
      "MANUAL",
      [shape(0)],
      population,
    );

    if (roundNumber < 5) {
      duels.completeResultAnimation(
        created.duelId,
        first,
        roundNumber,
      );
      duels.completeResultAnimation(
        created.duelId,
        second,
        roundNumber,
      );
      const resultPhase = [...firstEvents]
        .reverse()
        .find(
          (event) =>
            event.type === "result_phase_started" &&
            event.roundNumber === roundNumber,
        )?.resultPhase;
      assert.ok(resultPhase);
      runtime.fireNextTimerAt(resultPhase.endsAt);
    }
  }

  assert.equal(
    firstEvents.filter((event) => event.type === "round_started").length,
    5,
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "round_resolved").length,
    5,
  );
  assert.equal(
    secondEvents.filter((event) => event.type === "round_started").length,
    5,
  );
  assert.equal(
    secondEvents.filter((event) => event.type === "round_resolved").length,
    5,
  );
  const firstComplete = firstEvents.find(
    (event) => event.type === "game_completed",
  );
  const secondComplete = secondEvents.find(
    (event) => event.type === "game_completed",
  );
  assert.equal(firstComplete?.outcome, "WIN");
  assert.equal(firstComplete?.totalScore, 50_000);
  assert.equal(secondComplete?.outcome, "LOSS");
  assert.equal(secondComplete?.totalScore, 0);
});

test("manual submission broadcasts one authoritative 10-second deadline cap", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const firstEvents: DirectDuelEvent[] = [];
  const secondEvents: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => firstEvents.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, (event) => secondEvents.push(event));
  const round = firstEvents.find(
    (event) => event.type === "round_started",
  )?.round;
  assert.ok(round);
  runtime.moveTo(new Date(new Date(round.startedAt).getTime() + 20_000));

  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  const firstDeadlineEvent = firstEvents.find(
    (event) => event.type === "round_deadline_updated",
  );
  const secondDeadlineEvent = secondEvents.find(
    (event) => event.type === "round_deadline_updated",
  );
  assert.ok(firstDeadlineEvent?.round);
  assert.deepEqual(secondDeadlineEvent?.round, firstDeadlineEvent.round);
  assert.equal(
    new Date(firstDeadlineEvent.round.endsAt).getTime(),
    runtime.now.getTime() + 10_000,
  );

  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(0)],
    population,
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "round_deadline_updated")
      .length,
    1,
  );
});

test("ready actions wait for both players and reject stale rounds", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const events: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => events.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, () => undefined);
  runtime.moveTo("2026-01-01T00:00:01.000Z");
  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  await duels.submit(
    duelId,
    second,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );

  assert.throws(
    () => duels.readyForNextRound(duelId, first, 1),
    /result wait has not started/,
  );
  const firstAnimation = duels.completeResultAnimation(duelId, first, 1);
  const duplicateAnimation = duels.completeResultAnimation(duelId, first, 1);
  assert.equal(firstAnimation.status, "APPLIED");
  assert.equal(duplicateAnimation.status, "DUPLICATE");
  assert.equal(duplicateAnimation.resultWaitStarted, false);
  duels.completeResultAnimation(duelId, second, 1);

  const firstReady = duels.readyForNextRound(duelId, first, 1);
  assert.equal(firstReady.roundAdvanced, false);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "round_started" && event.round?.roundNumber === 2,
    ).length,
    0,
  );

  const readyEventCount = events.filter(
    (event) => event.type === "player_ready",
  ).length;
  const duplicate = duels.readyForNextRound(duelId, first, 1);
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(
    events.filter((event) => event.type === "player_ready").length,
    readyEventCount,
  );

  const secondReady = duels.readyForNextRound(duelId, second, 1);
  assert.equal(secondReady.roundAdvanced, true);
  assert.equal(
    events.filter(
      (event) =>
        event.type === "round_started" && event.round?.roundNumber === 2,
    ).length,
    1,
  );
  assert.throws(
    () => duels.readyForNextRound(duelId, first, 1),
    /result phase is not active/,
  );
  const staleAnimation = duels.completeResultAnimation(duelId, first, 1);
  assert.equal(staleAnimation.status, "STALE");
  assert.equal(staleAnimation.resultWaitStarted, false);
});

test("active-round abandon sends one terminal LOSS/WIN result", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const firstEvents: DirectDuelEvent[] = [];
  const secondEvents: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => firstEvents.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, (event) => secondEvents.push(event));

  const abandoned = duels.abandon(duelId, first);
  const eventCount = firstEvents.length + secondEvents.length;
  const duplicate = duels.abandon(duelId, first);
  const firstCompletion = firstEvents.find(
    (event) => event.type === "game_completed",
  );
  const secondCompletion = secondEvents.find(
    (event) => event.type === "game_completed",
  );
  const opponentAbandoned = secondEvents.find(
    (event) => event.type === "opponent_abandoned",
  );

  assert.equal(abandoned.status, "APPLIED");
  assert.equal(duplicate.status, "DUPLICATE");
  assert.equal(firstEvents.length + secondEvents.length, eventCount);
  assert.equal(firstCompletion?.outcome, "LOSS");
  assert.equal(secondCompletion?.outcome, "WIN");
  assert.equal(firstCompletion?.completionReason, "ABANDON");
  assert.equal(secondCompletion?.completionReason, "ABANDON");
  assert.equal(
    opponentAbandoned?.abandonedRuntimePlayerId,
    first.runtimePlayerId,
  );
  assert.equal(firstCompletion?.totalScore, 0);
  assert.equal(secondCompletion?.totalScore, 0);
  assert.equal(runtime.activeTimerCount(), 0);

  await assert.rejects(
    () =>
      duels.submit(
        duelId,
        second,
        1,
        "MANUAL",
        [shape(1_000)],
        population,
      ),
    /round is not active/,
  );
  assert.throws(
    () => duels.readyForNextRound(duelId, second, 1),
    /result phase is not active/,
  );
  assert.equal(
    duels.completeResultAnimation(duelId, second, 1).status,
    "STALE",
  );
  assert.equal(
    firstEvents.filter((event) => event.type === "round_started").length,
    1,
  );
});

test("abandon during result animation is terminal without starting result wait", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const events: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => events.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, () => undefined);
  runtime.moveTo("2026-01-01T00:00:01.000Z");
  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  await duels.submit(
    duelId,
    second,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );

  const abandoned = duels.abandon(duelId, first);

  assert.equal(abandoned.status, "APPLIED");
  assert.equal(
    events.filter((event) => event.type === "result_phase_started").length,
    0,
  );
  assert.equal(
    duels.completeResultAnimation(duelId, second, 1).status,
    "STALE",
  );
  assert.equal(runtime.activeTimerCount(), 0);
  assert.equal(
    events.filter((event) => event.type === "round_started").length,
    1,
  );
});

test("abandon during result waiting cancels auto-advance", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const events: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => events.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, () => undefined);
  runtime.moveTo("2026-01-01T00:00:01.000Z");
  await duels.submit(
    duelId,
    first,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  await duels.submit(
    duelId,
    second,
    1,
    "MANUAL",
    [shape(1_000)],
    population,
  );
  duels.completeResultAnimation(duelId, first, 1);
  duels.completeResultAnimation(duelId, second, 1);
  assert.equal(runtime.activeTimerCount(), 1);

  const abandoned = duels.abandon(duelId, second);

  assert.equal(abandoned.status, "APPLIED");
  assert.equal(runtime.activeTimerCount(), 0);
  assert.throws(
    () => duels.readyForNextRound(duelId, first, 1),
    /result phase is not active/,
  );
  assert.equal(
    events.filter((event) => event.type === "round_started").length,
    1,
  );
});

test("equal five-round totals deliver DRAW to both clients", async () => {
  const runtime = new FakeRuntime();
  const duels = service(runtime);
  const first = guest("player-1");
  const second = guest("player-2");
  const firstEvents: DirectDuelEvent[] = [];
  const secondEvents: DirectDuelEvent[] = [];
  const { duelId } = duels.create(first, "EASY");
  duels.subscribe(duelId, first, (event) => firstEvents.push(event));
  duels.join(second, duelId);
  duels.subscribe(duelId, second, (event) => secondEvents.push(event));

  for (let roundNumber = 1; roundNumber <= 5; roundNumber += 1) {
    const currentRound = [...firstEvents]
      .reverse()
      .find((event) => event.type === "round_started")?.round;
    assert.equal(currentRound?.roundNumber, roundNumber);
    runtime.moveTo(new Date(new Date(currentRound.startedAt).getTime() + 1_000));
    await duels.submit(
      duelId,
      first,
      roundNumber,
      "MANUAL",
      [shape(1_000)],
      population,
    );
    await duels.submit(
      duelId,
      second,
      roundNumber,
      "MANUAL",
      [shape(1_000)],
      population,
    );
    if (roundNumber < 5) {
      duels.completeResultAnimation(duelId, first, roundNumber);
      duels.completeResultAnimation(duelId, second, roundNumber);
      duels.readyForNextRound(duelId, first, roundNumber);
      duels.readyForNextRound(duelId, second, roundNumber);
    }
  }

  assert.equal(
    firstEvents.find((event) => event.type === "game_completed")?.outcome,
    "DRAW",
  );
  assert.equal(
    secondEvents.find((event) => event.type === "game_completed")?.outcome,
    "DRAW",
  );
});
