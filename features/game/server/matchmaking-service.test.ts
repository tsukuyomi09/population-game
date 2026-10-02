import assert from "node:assert/strict";
import test from "node:test";
import type {
  GuestRuntimePlayer,
  RegisteredRuntimePlayer,
  RuntimePlayer,
} from "../runtime-player";
import {
  MAXIMUM_RANKED_MATCHMAKING_DIFFERENCE,
  MatchmakingService,
  rankedMatchmakingRange,
  type MatchmakingEvent,
  type MatchmakingState,
} from "./matchmaking-service";

function guest(id: string): GuestRuntimePlayer {
  return {
    kind: "guest",
    runtimePlayerId: id,
    guestSessionId: `${id}-session`,
  };
}

function registered(id: string): RegisteredRuntimePlayer {
  return {
    kind: "registered",
    runtimePlayerId: id,
    userId: `${id}-user`,
  };
}

class FakeDuelFactory {
  matches: Array<{
    firstPlayer: RuntimePlayer;
    secondPlayer: RuntimePlayer;
    difficulty: "EASY" | "REAL";
    rated: boolean;
  }> = [];

  create = (
    firstPlayer: RuntimePlayer,
    secondPlayer: RuntimePlayer,
    difficulty: "EASY" | "REAL",
    rated: boolean,
  ) => {
    this.matches.push({ firstPlayer, secondPlayer, difficulty, rated });
    return { duelId: `duel-${this.matches.length}`, rated };
  };
}

class FakeClock {
  private currentTime = 0;
  private nextTimerId = 0;
  private readonly timers: Array<{
    id: number;
    at: number;
    callback: () => void;
    canceled: boolean;
  }> = [];

  now = () => this.currentTime;

  schedule = (callback: () => void, delayMs: number) => {
    const timer = {
      id: this.nextTimerId++,
      at: this.currentTime + delayMs,
      callback,
      canceled: false,
    };
    this.timers.push(timer);
    return () => {
      timer.canceled = true;
    };
  };

  advanceTo(time: number) {
    assert.ok(time >= this.currentTime);
    while (true) {
      const due = this.timers
        .filter((timer) => !timer.canceled && timer.at <= time)
        .sort((left, right) => left.at - right.at || left.id - right.id)[0];
      if (!due) break;
      due.canceled = true;
      this.currentTime = due.at;
      due.callback();
    }
    this.currentTime = time;
  }
}

function waiting(state: MatchmakingState) {
  assert.equal(state.status, "WAITING");
  if (state.status !== "WAITING") throw new Error("Expected WAITING state.");
  return state;
}

test("guest and registered players pair once in the unrated queue", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);
  const first = guest("guest-a");
  const second = registered("member-b");

  const firstAttempt = waiting(service.join(first, "DUEL", "EASY"));
  const secondMatch = service.join(second, "DUEL", "EASY");
  assert.equal(secondMatch.status, "MATCHED");
  assert.equal(secondMatch.status === "MATCHED" && secondMatch.duelId, "duel-1");
  assert.equal(firstAttempt.intent, "DUEL");
  assert.equal(firstAttempt.difficulty, "EASY");
  assert.equal(duels.matches.length, 1);
  assert.equal(duels.matches[0]?.rated, false);

  assert.equal(service.join(guest("guest-c"), "DUEL", "EASY").status, "WAITING");
  assert.equal(duels.matches.length, 1);
});

test("only registered players enter Ranked and matched Ranked is rated", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);

  assert.throws(
    () => service.join(guest("guest"), "RANKED", "EASY"),
    /registered account/,
  );
  assert.equal(
    service.join(registered("a"), "RANKED", "REAL", 1_000).status,
    "WAITING",
  );
  const match = service.join(registered("b"), "RANKED", "REAL", 1_000);

  assert.equal(match.status, "MATCHED");
  assert.equal(match.rated, true);
  assert.equal(duels.matches[0]?.rated, true);
});

test("intent and difficulty form separate compatibility queues", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);

  service.join(registered("duel-easy"), "DUEL", "EASY");
  service.join(registered("duel-real"), "DUEL", "REAL");
  service.join(registered("ranked-easy"), "RANKED", "EASY", 1_000);

  assert.equal(
    service.join(guest("duel-easy-2"), "DUEL", "EASY").status,
    "MATCHED",
  );
  assert.equal(
    service.join(guest("duel-real-2"), "DUEL", "REAL").status,
    "MATCHED",
  );
  assert.equal(
    service.join(registered("ranked-easy-2"), "RANKED", "EASY", 1_000)
      .status,
    "MATCHED",
  );
  assert.deepEqual(
    duels.matches.map(({ difficulty, rated }) => ({ difficulty, rated })),
    [
      { difficulty: "EASY", rated: false },
      { difficulty: "REAL", rated: false },
      { difficulty: "EASY", rated: true },
    ],
  );
});

test("leaving or losing the queue subscription removes the entry", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);
  const canceled = guest("canceled");
  const disconnected = guest("disconnected");

  const canceledAttempt = waiting(service.join(canceled, "DUEL", "EASY"));
  assert.deepEqual(service.leave(canceled, canceledAttempt.attemptId), {
    status: "LEFT",
    attemptId: canceledAttempt.attemptId,
  });
  assert.equal(
    service.join(guest("replacement"), "DUEL", "EASY").status,
    "WAITING",
  );

  const disconnectedAttempt = waiting(
    service.join(disconnected, "DUEL", "REAL"),
  );
  const unsubscribe = service.subscribe(
    disconnected,
    disconnectedAttempt.attemptId,
    () => undefined,
  );
  unsubscribe();
  assert.equal(
    service.join(guest("real-replacement"), "DUEL", "REAL").status,
    "WAITING",
  );
  assert.equal(duels.matches.length, 0);
});

test("a waiting player receives one match even when subscribing after pairing", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);
  const first = guest("first");
  const events: MatchmakingEvent[] = [];

  const firstAttempt = waiting(service.join(first, "DUEL", "EASY"));
  service.join(guest("second"), "DUEL", "EASY");
  const unsubscribe = service.subscribe(
    first,
    firstAttempt.attemptId,
    (event) => events.push(event),
  );

  assert.deepEqual(events, [
    {
      status: "MATCHED",
      attemptId: firstAttempt.attemptId,
      duelId: "duel-1",
      intent: "DUEL",
      difficulty: "EASY",
      rated: false,
    },
  ]);
  unsubscribe();

  assert.equal(service.join(guest("third"), "DUEL", "EASY").status, "WAITING");
  assert.equal(duels.matches.length, 1);
});

test("duplicate joins do not create duplicate queue entries or matches", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);
  const first = registered("first");

  assert.equal(service.join(first, "DUEL", "EASY").status, "WAITING");
  assert.equal(service.join(first, "DUEL", "EASY").status, "WAITING");
  assert.throws(() => service.join(first, "RANKED", "EASY"), /Leave the current/);
  assert.equal(service.join(guest("second"), "DUEL", "EASY").status, "MATCHED");
  assert.equal(duels.matches.length, 1);
});

test("cancel racing a completed pairing returns that match and clears pending state", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);
  const first = guest("first");

  const attempt = waiting(service.join(first, "DUEL", "EASY"));
  service.join(guest("second"), "DUEL", "EASY");
  const leave = service.leave(first, attempt.attemptId);

  assert.equal(leave.status, "MATCHED");
  if (leave.status !== "MATCHED") throw new Error("Expected MATCHED state.");
  service.acknowledgeMatch(first, leave.attemptId, leave.duelId);
  assert.equal(service.join(first, "DUEL", "REAL").status, "WAITING");
  assert.equal(duels.matches.length, 1);
});

test("Ranked search ranges widen at the approved boundaries and stop at 400", () => {
  assert.equal(rankedMatchmakingRange(-1), 50);
  assert.equal(rankedMatchmakingRange(0), 50);
  assert.equal(rankedMatchmakingRange(9_999), 50);
  assert.equal(rankedMatchmakingRange(10_000), 100);
  assert.equal(rankedMatchmakingRange(20_000), 150);
  assert.equal(rankedMatchmakingRange(30_000), 200);
  assert.equal(rankedMatchmakingRange(45_000), 300);
  assert.equal(rankedMatchmakingRange(60_000), 400);
  assert.equal(rankedMatchmakingRange(600_000), 400);
  assert.equal(MAXIMUM_RANKED_MATCHMAKING_DIFFERENCE, 400);
});

test("waiting Ranked players are paired when a timer widens both ranges", () => {
  const duels = new FakeDuelFactory();
  const clock = new FakeClock();
  const service = new MatchmakingService(duels.create, clock);
  const first = registered("first");
  const events: MatchmakingEvent[] = [];

  const firstAttempt = waiting(service.join(first, "RANKED", "EASY", 1_000));
  service.subscribe(first, firstAttempt.attemptId, (event) => events.push(event));
  assert.equal(
    service.join(registered("second"), "RANKED", "EASY", 1_100).status,
    "WAITING",
  );
  assert.equal(duels.matches.length, 0);

  clock.advanceTo(10_000);

  assert.equal(duels.matches.length, 1);
  assert.deepEqual(
    duels.matches[0] && {
      players: [
        duels.matches[0].firstPlayer.runtimePlayerId,
        duels.matches[0].secondPlayer.runtimePlayerId,
      ],
      difficulty: duels.matches[0].difficulty,
      rated: duels.matches[0].rated,
    },
    {
      players: ["first", "second"],
      difficulty: "EASY",
      rated: true,
    },
  );
  assert.equal(events.filter((event) => event.status === "MATCHED").length, 1);
  clock.advanceTo(120_000);
  assert.equal(duels.matches.length, 1);
});

test("Ranked compatibility is mutual when one player has waited longer", () => {
  const duels = new FakeDuelFactory();
  const clock = new FakeClock();
  const service = new MatchmakingService(duels.create, clock);

  service.join(registered("older"), "RANKED", "REAL", 1_400);
  clock.advanceTo(60_000);
  assert.equal(
    service.join(registered("newer"), "RANKED", "REAL", 1_500).status,
    "WAITING",
  );
  assert.equal(duels.matches.length, 0);

  clock.advanceTo(70_000);
  assert.equal(duels.matches.length, 1);
});

test("Ranked selects the smallest MMR difference before queue age", () => {
  const duels = new FakeDuelFactory();
  const clock = new FakeClock();
  const service = new MatchmakingService(duels.create, clock);

  service.join(registered("oldest"), "RANKED", "EASY", 1_050);
  service.join(registered("closer-a"), "RANKED", "EASY", 1_400);
  service.join(registered("closer-b"), "RANKED", "EASY", 1_500);
  clock.advanceTo(60_000);

  assert.equal(duels.matches.length, 1);
  assert.deepEqual(
    [
      duels.matches[0]?.firstPlayer.runtimePlayerId,
      duels.matches[0]?.secondPlayer.runtimePlayerId,
    ],
    ["closer-a", "closer-b"],
  );
  assert.equal(
    service.join(registered("oldest-opponent"), "RANKED", "EASY", 1_040)
      .status,
    "MATCHED",
  );
});

test("Ranked uses queue age only to break equal-quality ties", () => {
  const duels = new FakeDuelFactory();
  const clock = new FakeClock();
  const service = new MatchmakingService(duels.create, clock);

  service.join(registered("oldest"), "RANKED", "REAL", 1_300);
  service.join(registered("middle"), "RANKED", "REAL", 1_400);
  service.join(registered("newest"), "RANKED", "REAL", 1_500);
  clock.advanceTo(10_000);

  assert.deepEqual(
    [
      duels.matches[0]?.firstPlayer.runtimePlayerId,
      duels.matches[0]?.secondPlayer.runtimePlayerId,
    ],
    ["oldest", "middle"],
  );
});

test("Ranked never pairs players more than 400 MMR apart", () => {
  const duels = new FakeDuelFactory();
  const clock = new FakeClock();
  const service = new MatchmakingService(duels.create, clock);

  service.join(registered("first"), "RANKED", "EASY", 1_000);
  service.join(registered("second"), "RANKED", "EASY", 1_401);
  clock.advanceTo(120_000);

  assert.equal(duels.matches.length, 0);
});

test("Easy and Real Ranked queues use independent MMR pools", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);

  service.join(registered("easy-a"), "RANKED", "EASY", 1_000);
  service.join(registered("real-a"), "RANKED", "REAL", 1_000);
  assert.equal(
    service.join(registered("easy-b"), "RANKED", "EASY", 1_010).status,
    "MATCHED",
  );
  assert.equal(
    service.join(registered("real-b"), "RANKED", "REAL", 995).status,
    "MATCHED",
  );

  assert.deepEqual(
    duels.matches.map((match) => match.difficulty),
    ["EASY", "REAL"],
  );
});

test("Ranked cancellation and disconnect cleanup remove timed queue entries", () => {
  const duels = new FakeDuelFactory();
  const clock = new FakeClock();
  const service = new MatchmakingService(duels.create, clock);
  const canceled = registered("canceled");
  const disconnected = registered("disconnected");

  const canceledAttempt = waiting(
    service.join(canceled, "RANKED", "EASY", 1_000),
  );
  assert.deepEqual(service.leave(canceled, canceledAttempt.attemptId), {
    status: "LEFT",
    attemptId: canceledAttempt.attemptId,
  });
  assert.equal(
    service.join(registered("easy-replacement"), "RANKED", "EASY", 1_000)
      .status,
    "WAITING",
  );

  const disconnectedAttempt = waiting(
    service.join(disconnected, "RANKED", "REAL", 1_000),
  );
  const unsubscribe = service.subscribe(
    disconnected,
    disconnectedAttempt.attemptId,
    () => undefined,
  );
  unsubscribe();
  assert.equal(
    service.join(registered("real-replacement"), "RANKED", "REAL", 1_000)
      .status,
    "WAITING",
  );

  clock.advanceTo(120_000);
  assert.equal(duels.matches.length, 0);
});

test("stale leave and disconnect cleanup cannot remove a newer queue attempt", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);
  const player = registered("churning");

  const oldAttempt = waiting(
    service.join(player, "RANKED", "EASY", 1_000),
  );
  const disconnectOldAttempt = service.subscribe(
    player,
    oldAttempt.attemptId,
    () => undefined,
  );
  service.leave(player, oldAttempt.attemptId);

  const currentAttempt = waiting(
    service.join(player, "RANKED", "REAL", 1_000),
  );
  disconnectOldAttempt();
  assert.deepEqual(service.leave(player, oldAttempt.attemptId), {
    status: "LEFT",
    attemptId: oldAttempt.attemptId,
  });

  const duplicateJoin = waiting(
    service.join(player, "RANKED", "REAL", 1_000),
  );
  assert.equal(duplicateJoin.attemptId, currentAttempt.attemptId);

  const opponentMatch = service.join(
    registered("opponent"),
    "RANKED",
    "REAL",
    1_000,
  );
  assert.equal(opponentMatch.status, "MATCHED");
  assert.equal(duels.matches.length, 1);
});

test("a match is delivered only to its queue attempt and remains until acknowledged", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);
  const first = registered("first");
  const oldEvents: MatchmakingEvent[] = [];
  const currentEvents: MatchmakingEvent[] = [];

  const oldAttempt = waiting(
    service.join(first, "RANKED", "EASY", 1_000),
  );
  service.subscribe(first, oldAttempt.attemptId, (event) => {
    oldEvents.push(event);
  });
  service.leave(first, oldAttempt.attemptId);

  const currentAttempt = waiting(
    service.join(first, "RANKED", "REAL", 1_000),
  );
  const secondMatch = service.join(
    registered("second"),
    "RANKED",
    "REAL",
    1_000,
  );
  assert.equal(secondMatch.status, "MATCHED");
  if (secondMatch.status !== "MATCHED") {
    throw new Error("Expected MATCHED state.");
  }
  assert.equal(
    oldEvents.filter((event) => event.status === "MATCHED").length,
    0,
  );

  const disconnectCurrent = service.subscribe(
    first,
    currentAttempt.attemptId,
    (event) => currentEvents.push(event),
  );
  assert.equal(currentEvents.length, 1);
  assert.equal(currentEvents[0]?.status, "MATCHED");
  assert.equal(
    currentEvents[0]?.status === "MATCHED" && currentEvents[0].duelId,
    secondMatch.duelId,
  );

  disconnectCurrent();
  const redelivered: MatchmakingEvent[] = [];
  service.subscribe(first, currentAttempt.attemptId, (event) => {
    redelivered.push(event);
  });
  assert.equal(redelivered[0]?.status, "MATCHED");

  service.acknowledgeMatch(
    first,
    currentAttempt.attemptId,
    secondMatch.duelId,
  );
  const afterAcknowledgement: MatchmakingEvent[] = [];
  service.subscribe(first, currentAttempt.attemptId, (event) => {
    afterAcknowledgement.push(event);
  });
  assert.deepEqual(afterAcknowledgement, [
    { status: "LEFT", attemptId: currentAttempt.attemptId },
  ]);
});

test("repeated Ranked join cancel switch and delayed cleanup still pairs both players once", () => {
  const duels = new FakeDuelFactory();
  const clock = new FakeClock();
  const service = new MatchmakingService(duels.create, clock);
  const first = registered("first");
  const second = registered("second");

  for (let cycle = 0; cycle < 50; cycle += 1) {
    const firstOld = waiting(
      service.join(first, "RANKED", "EASY", 1_000),
    );
    const secondOld = waiting(
      service.join(second, "RANKED", "REAL", 1_000),
    );
    const disconnectFirstOld = service.subscribe(
      first,
      firstOld.attemptId,
      () => undefined,
    );
    const disconnectSecondOld = service.subscribe(
      second,
      secondOld.attemptId,
      () => undefined,
    );
    service.leave(first, firstOld.attemptId);
    service.leave(second, secondOld.attemptId);

    const firstCurrent = waiting(
      service.join(first, "RANKED", "REAL", 1_000),
    );
    const secondCurrent = waiting(
      service.join(second, "RANKED", "EASY", 1_000),
    );
    disconnectFirstOld();
    disconnectSecondOld();
    service.leave(first, firstOld.attemptId);
    service.leave(second, secondOld.attemptId);

    assert.equal(
      waiting(service.join(first, "RANKED", "REAL", 1_000)).attemptId,
      firstCurrent.attemptId,
    );
    assert.equal(
      waiting(service.join(second, "RANKED", "EASY", 1_000)).attemptId,
      secondCurrent.attemptId,
    );
    service.leave(first, firstCurrent.attemptId);
    service.leave(second, secondCurrent.attemptId);
  }

  const firstAttempt = waiting(
    service.join(first, "RANKED", "EASY", 1_000),
  );
  const firstEvents: MatchmakingEvent[] = [];
  service.subscribe(first, firstAttempt.attemptId, (event) => {
    firstEvents.push(event);
  });
  const secondMatch = service.join(second, "RANKED", "EASY", 1_025);
  assert.equal(secondMatch.status, "MATCHED");
  if (secondMatch.status !== "MATCHED") {
    throw new Error("Expected MATCHED state.");
  }
  const secondEvents: MatchmakingEvent[] = [];
  service.subscribe(second, secondMatch.attemptId, (event) => {
    secondEvents.push(event);
  });

  const firstMatches = firstEvents.filter(
    (event): event is Extract<MatchmakingEvent, { status: "MATCHED" }> =>
      event.status === "MATCHED",
  );
  const secondMatches = secondEvents.filter(
    (event): event is Extract<MatchmakingEvent, { status: "MATCHED" }> =>
      event.status === "MATCHED",
  );
  assert.equal(firstMatches.length, 1);
  assert.equal(secondMatches.length, 1);
  assert.equal(firstMatches[0]?.duelId, secondMatches[0]?.duelId);
  assert.equal(firstMatches[0]?.duelId, secondMatch.duelId);
  assert.equal(duels.matches.length, 1);

  service.acknowledgeMatch(
    first,
    firstAttempt.attemptId,
    secondMatch.duelId,
  );
  service.acknowledgeMatch(
    second,
    secondMatch.attemptId,
    secondMatch.duelId,
  );
  clock.advanceTo(120_000);
  assert.equal(duels.matches.length, 1);
});

test("hidden MMR never appears in public matchmaking states or events", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);
  const player = registered("first");
  const events: MatchmakingEvent[] = [];

  const waiting = service.join(player, "RANKED", "EASY", 1_234);
  assert.equal(waiting.status, "WAITING");
  if (waiting.status !== "WAITING") throw new Error("Expected WAITING state.");
  const unsubscribe = service.subscribe(
    player,
    waiting.attemptId,
    (event) => events.push(event),
  );

  assert.doesNotMatch(JSON.stringify(waiting), /mmr|1234/i);
  assert.doesNotMatch(JSON.stringify(events), /mmr|1234/i);
  unsubscribe();
});

test("Ranked validates its server-provided hidden MMR", () => {
  const service = new MatchmakingService(new FakeDuelFactory().create);

  assert.throws(
    () => service.join(registered("missing"), "RANKED", "EASY"),
    /MMR is invalid/,
  );
  assert.throws(
    () => service.join(registered("below-floor"), "RANKED", "EASY", 399),
    /MMR is invalid/,
  );
});
