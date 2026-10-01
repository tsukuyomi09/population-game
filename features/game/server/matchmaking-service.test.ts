import assert from "node:assert/strict";
import test from "node:test";
import type {
  GuestRuntimePlayer,
  RegisteredRuntimePlayer,
  RuntimePlayer,
} from "../runtime-player";
import {
  MatchmakingService,
  type MatchmakingEvent,
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

test("guest and registered players pair once in the unrated queue", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);
  const first = guest("guest-a");
  const second = registered("member-b");

  assert.deepEqual(service.join(first, "DUEL", "EASY"), {
    status: "WAITING",
    intent: "DUEL",
    difficulty: "EASY",
  });
  assert.deepEqual(service.join(second, "DUEL", "EASY"), {
    status: "MATCHED",
    duelId: "duel-1",
    intent: "DUEL",
    difficulty: "EASY",
    rated: false,
  });
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
    service.join(registered("a"), "RANKED", "REAL").status,
    "WAITING",
  );
  const match = service.join(registered("b"), "RANKED", "REAL");

  assert.equal(match.status, "MATCHED");
  assert.equal(match.rated, true);
  assert.equal(duels.matches[0]?.rated, true);
});

test("intent and difficulty form separate compatibility queues", () => {
  const duels = new FakeDuelFactory();
  const service = new MatchmakingService(duels.create);

  service.join(registered("duel-easy"), "DUEL", "EASY");
  service.join(registered("duel-real"), "DUEL", "REAL");
  service.join(registered("ranked-easy"), "RANKED", "EASY");

  assert.equal(
    service.join(guest("duel-easy-2"), "DUEL", "EASY").status,
    "MATCHED",
  );
  assert.equal(
    service.join(guest("duel-real-2"), "DUEL", "REAL").status,
    "MATCHED",
  );
  assert.equal(
    service.join(registered("ranked-easy-2"), "RANKED", "EASY").status,
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

  service.join(canceled, "DUEL", "EASY");
  assert.deepEqual(service.leave(canceled), { status: "LEFT" });
  assert.equal(
    service.join(guest("replacement"), "DUEL", "EASY").status,
    "WAITING",
  );

  service.join(disconnected, "DUEL", "REAL");
  const unsubscribe = service.subscribe(disconnected, () => undefined);
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

  service.join(first, "DUEL", "EASY");
  service.join(guest("second"), "DUEL", "EASY");
  const unsubscribe = service.subscribe(first, (event) => events.push(event));

  assert.deepEqual(events, [
    {
      status: "MATCHED",
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

  service.join(first, "DUEL", "EASY");
  service.join(guest("second"), "DUEL", "EASY");
  const leave = service.leave(first);

  assert.equal(leave.status, "MATCHED");
  assert.equal(service.join(first, "DUEL", "REAL").status, "WAITING");
  assert.equal(duels.matches.length, 1);
});
