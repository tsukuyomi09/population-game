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
    this.moveTo(round.endsAt);
    const timer = this.timers.find((candidate) => !candidate.cancelled);
    assert.ok(timer);
    timer.cancelled = true;
    timer.callback();
  }
}

function service(runtime: FakeRuntime) {
  return new DirectDuelService({
    generateDuelId: () => "duel-1",
    generateTarget: () => 1_000,
    roundDurationMs: 60_000,
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
